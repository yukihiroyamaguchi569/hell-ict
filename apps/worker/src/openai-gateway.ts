import { parseOpenAiChatCompletion, parseOpenAiErrorBody } from "@hell-ict/domain";
import type { AiGateway, AiMessage, AiRequest, AiResponse } from "@hell-ict/domain";

/**
 * OpenAIがポリシー拒否（content: null + refusal）を返したことを、タイムアウトや
 * レート制限など他の失敗と型で区別するためのエラー。呼び出し側（index.ts）は
 * これを「再試行すれば直るかもしれない失敗」と分けて扱う。
 */
export class OpenAiRefusalError extends Error {}

/**
 * 失敗の種別。HTTPエラー（OpenAIが応答を返した）、タイムアウト（こちらが打ち切った）、
 * ネットワーク（応答が届かなかった）、応答の形の不一致（200だが使えない）を分ける。
 */
export type OpenAiFailureReason = "http_error" | "timeout" | "network" | "invalid_response";

/**
 * 活動ログへ残す失敗の原因。エラー本文そのものは持たない——本文の`message`は自由文で、
 * 送ったプロンプトやキーの一部が混ざりうる。識別子だけをschemaで検証して取り出す。
 */
export type OpenAiFailure = {
  readonly reason: OpenAiFailureReason;
  readonly status: number | null;
  readonly code: string | null;
  readonly type: string | null;
};

/** 拒否以外のOpenAI呼び出しの失敗。原因を`failure`に持つ。 */
export class OpenAiRequestError extends Error {
  constructor(
    message: string,
    readonly failure: OpenAiFailure,
  ) {
    super(message);
  }
}

const failureOf = (reason: OpenAiFailureReason): OpenAiFailure => ({
  reason,
  status: null,
  code: null,
  type: null,
});

/**
 * エラー本文を読む上限。OpenAIのエラー本文は数百バイトなので、これを超える本文は
 * 読み切らずに捨てる（プロキシのHTMLなど、記録に使えない巨大な本文でメモリを使わない）。
 */
const ERROR_BODY_MAX_BYTES = 8 * 1024;

/**
 * エラー応答の本文を上限つきで読み、JSONとして解釈する。読めない・大きすぎる・JSONでない
 * ときはnullを返す——本文が読めなくてもHTTPステータスは記録したいので、例外にしない。
 */
const readBoundedErrorBody = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ERROR_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
};

const httpError = async (response: Response): Promise<OpenAiRequestError> => {
  const { code, type } = parseOpenAiErrorBody(await readBoundedErrorBody(response));
  return new OpenAiRequestError(`OpenAI応答が異常です（status ${String(response.status)}）。`, {
    reason: "http_error",
    status: response.status,
    code,
    type,
  });
};

const invalidResponse = (message: string): OpenAiRequestError =>
  new OpenAiRequestError(message, failureOf("invalid_response"));

const parseJsonBody = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw invalidResponse("OpenAI応答がJSONではありません。");
  }
};

/** 200で返った本文から応答文を取り出す。使えない形は`invalid_response`として投げる。 */
const extractContent = (body: unknown): string => {
  let completion;
  try {
    completion = parseOpenAiChatCompletion(body);
  } catch {
    throw invalidResponse("OpenAI応答の形式が不正です。");
  }
  const message = completion.choices[0]?.message;
  if (message === undefined) throw invalidResponse("OpenAI応答にcontentがありません。");
  if (message.content === null) {
    if (message.refusal !== null && message.refusal !== undefined) {
      throw new OpenAiRefusalError(message.refusal);
    }
    throw invalidResponse("OpenAI応答にcontentがありません。");
  }
  return message.content;
};

/**
 * `AiGateway`のOpenAI adapter。domainからCloudflare/OpenAIを直接importさせないため、
 * ここWorker側だけに置く。APIキーはこの呼び出しの外へは出さない。
 */
export class OpenAiGateway implements AiGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(request: AiRequest): Promise<AiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);
    // 打ち切りはこちらのタイマーだけが起こす。abort済みならタイムアウト、そうでなければ
    // 接続や本文の受信そのものが失敗した、と読む。
    const transportError = (): OpenAiRequestError =>
      controller.signal.aborted
        ? new OpenAiRequestError(
            `AI応答が${String(request.timeoutMs)}ms以内に完了しませんでした。`,
            failureOf("timeout"),
          )
        : new OpenAiRequestError("OpenAIへの接続に失敗しました。", failureOf("network"));
    try {
      const response = await this.post(request, controller.signal).catch(() => {
        throw transportError();
      });
      // エラー本文の受信中に打ち切られても、ステータスは受け取れているのでhttp_errorとする
      // （原因はステータスの方にある）。本文から拾えなかったcode・typeは空のまま残る。
      if (!response.ok) throw await httpError(response);
      // 受信の失敗（通信途絶・タイムアウト）と、受け取った本文がJSONでないことを分ける。
      const text = await response.text().catch(() => {
        throw transportError();
      });
      return { text: extractContent(parseJsonBody(text)) };
    } finally {
      clearTimeout(timer);
    }
  }

  private post(request: AiRequest, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages.map((message: AiMessage) => ({
          role: message.role,
          content: message.text,
        })),
      }),
      signal,
    });
  }
}

/** 活動ログの`chat.failure`へ足すmeta。nullの項目はキーごと省く。 */
export type AiFailureMeta = Record<string, string | number>;

/**
 * AI呼び出しの失敗を、活動ログのmetaへ変換する。OpenAiRequestError以外（想定外の例外や
 * テスト用のFake）は`unknown`とし、例外のmessageは残さない。
 */
export const aiFailureMeta = (caught: unknown): AiFailureMeta => {
  if (!(caught instanceof OpenAiRequestError)) return { failureReason: "unknown" };
  const { reason, status, code, type } = caught.failure;
  return {
    failureReason: reason,
    ...(status === null ? {} : { httpStatus: status }),
    ...(code === null ? {} : { errorCode: code }),
    ...(type === null ? {} : { errorType: type }),
  };
};
