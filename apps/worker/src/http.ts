import { commandIdSchema, teamCodeSchema } from "@hell-ict/domain";
import type { HttpErrorCode, TeamCode } from "@hell-ict/domain";

/**
 * fetchが受け取るenvとExecutionContextを束ねたもの。活動ログを`waitUntil`へ
 * 逃がすためにハンドラの奥までctxを届ける必要があるが、envとctxを別引数で
 * 引き回すとmax-params（4）に収まらなくなるため1つにまとめる。
 */
export type RequestScope = { readonly env: Env; readonly ctx: ExecutionContext };

export const json = (value: unknown, status = 200): Response => Response.json(value, { status });
export const error = (message: string, status: number, code?: HttpErrorCode): Response =>
  json(code === undefined ? { message } : { message, code }, status);
/** Retry-Afterのように追加ヘッダーを伴うエラー応答（429）用。本文の形はerrorと同じ。 */
export const errorWithHeaders = (
  message: string,
  status: number,
  headers: Record<string, string>,
): Response =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
/**
 * ゲームマスターのリセットより前に入室した端末からの書き込みへの応答。進捗・
 * チェックポイント・会話・コマンド・活動ログのどの経路でも同じ文言とcodeで返す
 * ——クライアントはどこで受けても同じ扱い（保存を止めて再読み込みを促す）へ倒せばよい。
 */
export const staleGenerationResponse = (): Response =>
  error(
    "この端末の状態は古くなっています。ページを再読み込みしてください。",
    409,
    "stale-generation",
  );

/** 本文が上限を超えたときにparseJsonが投げる。413へ変換するため他の失敗と区別する。 */
export class PayloadTooLargeError extends Error {}

/**
 * 上限を明示しないPOSTルート（session・commands・chat/threads・chat/messages・
 * progress）へ一律で掛かる既定値。チャット本文はschemaで4,000文字までなので、
 * UTF-8最大4バイト換算でも16KBに収まる。32KBはその倍で、正当な本文を巻き込まずに
 * 「本文で殴る」経路だけを止められる大きさとして採る。
 */
export const DEFAULT_BODY_MAX_BYTES = 32 * 1024;

const bodyDecoder = new TextDecoder();

/**
 * 本文を上限までチャンク読みし、超えた時点で読むのをやめる。
 *
 * `request.text()`は全量をメモリへ展開してから長さを返すので、読み切った後に
 * バイト数を測っても手遅れである（Content-Lengthを申告しないchunked転送では、
 * 上限がメモリ消費を何も制限していなかった）。ここでは超過を検知した瞬間に
 * `reader.cancel()`して送信元へ打ち切りを伝え、保持するのは上限＋最後の1チャンク
 * までに抑える。
 */
const readBodyText = async (request: Request, maxBytes: number): Promise<string> => {
  const body = request.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new PayloadTooLargeError();
      chunks.push(value);
    }
  } finally {
    // 打ち切りでも読み切りでも必ず解放する。読み切り後のcancelは無害。
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bodyDecoder.decode(merged);
};

/**
 * 本文をJSONへ展開する前にバイト数で弾く。`maxBytes`を省略した呼び出しにも
 * DEFAULT_BODY_MAX_BYTESが掛かる——上限の指定漏れが「無制限」を意味しないようにする。
 *
 * Content-Lengthがあればそれを見て、1バイトも読まずに打ち切る。ヘッダは偽装できる
 * （chunked転送では付かない）ので、実際に読んだバイト数でも必ず測り直す。
 * どちらの経路でも、上限を超えた文字列がJSON.parseへ渡ることはない。
 *
 * 上限を明示している呼び出しは活動ログ（64KB）とチェックポイント保存（96KB）。
 */
export const parseJson = async (
  request: Request,
  maxBytes: number = DEFAULT_BODY_MAX_BYTES,
): Promise<unknown> => {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError();
  return JSON.parse(await readBodyText(request, maxBytes)) as unknown;
};

/** parseJsonの失敗を、大きすぎる（413）と壊れている（400）へ振り分ける。 */
export const bodyErrorResponse = (caught: unknown, invalidMessage: string): Response =>
  caught instanceof PayloadTooLargeError
    ? error("リクエスト本文が大きすぎます。", 413)
    : error(invalidMessage, 400);

export const isWebSocketRequest = (request: Request): boolean =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";

export const teamCodeFromPath = (
  pathname: string,
  prefix: string,
  suffix: string,
): TeamCode | null => {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  return teamCodeSchema.safeParse(pathname.slice(prefix.length, -suffix.length)).data ?? null;
};

/**
 * `GET /api/teams/:code/chat?commandIds=`で一度に問い合わせられるIDの数。
 * クライアントが未確定として抱えるのは送信経路ごとに20件までで、そのうち
 * 実際に未解決で残るのは通常0〜数件である。20あれば復帰時の照会には足り、
 * 台帳への問い合わせ回数を無制限に増やされる余地も残さない。
 */
export const CHAT_COMMAND_IDS_MAX = 20;

/**
 * `?commandIds=<uuid>,<uuid>,…`を検証する。未指定はnull、1つでも形式が違うか
 * 上限を超えていたら400のResponse。重複は1件へ畳む（同じIDを何度並べても
 * 台帳を引く回数を増やせないようにする）。
 */
export const parseCommandIdsQuery = (url: URL): string[] | null | Response => {
  const raw = url.searchParams.get("commandIds");
  if (raw === null) return null;
  const unique = [...new Set(raw.split(","))];
  if (unique.length > CHAT_COMMAND_IDS_MAX) {
    return error(`commandIdsは${String(CHAT_COMMAND_IDS_MAX)}件までです。`, 400);
  }
  const commandIds: string[] = [];
  for (const value of unique) {
    const parsed = commandIdSchema.safeParse(value);
    if (!parsed.success) return error("commandIdsの形式が正しくありません。", 400);
    commandIds.push(parsed.data);
  }
  return commandIds;
};

/**
 * `/api/teams/:code/...`のcodeを、末尾のパスを問わず取り出す。入口ガードは
 * 個別エンドポイントを知らずに許可リストを当てたいので、teamCodeFromPathとは別に置く。
 */
export const teamCodeFromApiPath = (pathname: string): TeamCode | null => {
  const prefix = "/api/teams/";
  if (!pathname.startsWith(prefix)) return null;
  const [code] = pathname.slice(prefix.length).split("/");
  return teamCodeSchema.safeParse(code).data ?? null;
};
