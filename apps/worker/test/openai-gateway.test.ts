import { describe, expect, it } from "vitest";

import {
  aiFailureMeta,
  OpenAiGateway,
  OpenAiRefusalError,
  OpenAiRequestError,
} from "../src/openai-gateway.js";
import type { AiFailureMeta } from "../src/openai-gateway.js";

describe("OpenAiGateway", () => {
  it("APIキーはAuthorizationヘッダーにだけ乗せ、bodyには含めない", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "了解しました" } }] }), {
          status: 200,
        }),
      );
    }) as typeof fetch;
    try {
      const gateway = new OpenAiGateway("https://example.test/v1", "secret-key", "gpt-4o");
      const result = await gateway.complete({
        messages: [{ role: "user", text: "こんにちは" }],
        timeoutMs: 1_000,
      });
      expect(result).toEqual({ text: "了解しました" });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      if (call === undefined) throw new Error("unexpected");
      expect(call.url).toBe("https://example.test/v1/chat/completions");
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-key");
      expect(String(call.init.body)).not.toContain("secret-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("HTTPエラー応答は例外として伝え、OpenAiRefusalErrorとは区別する", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response("rate limited", { status: 429 }))) as typeof fetch;
    try {
      const gateway = new OpenAiGateway("https://example.test/v1", "secret-key", "gpt-4o");
      await expect(
        gateway.complete({ messages: [{ role: "user", text: "test" }], timeoutMs: 1_000 }),
      ).rejects.toThrow();
      await expect(
        gateway.complete({ messages: [{ role: "user", text: "test" }], timeoutMs: 1_000 }),
      ).rejects.not.toBeInstanceOf(OpenAiRefusalError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ポリシー拒否（content: null, refusal）はOpenAiRefusalErrorとして伝える", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: null, refusal: "対応できません" } }],
          }),
          { status: 200 },
        ),
      )) as typeof fetch;
    try {
      const gateway = new OpenAiGateway("https://example.test/v1", "secret-key", "gpt-4o");
      await expect(
        gateway.complete({ messages: [{ role: "user", text: "test" }], timeoutMs: 1_000 }),
      ).rejects.toThrow("対応できません");
      await expect(
        gateway.complete({ messages: [{ role: "user", text: "test" }], timeoutMs: 1_000 }),
      ).rejects.toBeInstanceOf(OpenAiRefusalError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refusal無しのcontent: nullは原因不明のエラーとして伝える", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), {
          status: 200,
        }),
      )) as typeof fetch;
    try {
      const gateway = new OpenAiGateway("https://example.test/v1", "secret-key", "gpt-4o");
      await expect(
        gateway.complete({ messages: [{ role: "user", text: "test" }], timeoutMs: 1_000 }),
      ).rejects.toThrow("contentがありません");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** fetchを差し替えてgatewayを1回呼び、投げられた例外を返す。 */
const failureFrom = async (
  fakeFetch: (init: RequestInit) => Promise<Response>,
  timeoutMs = 1_000,
): Promise<unknown> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) => fakeFetch(init)) as typeof fetch;
  try {
    const gateway = new OpenAiGateway("https://example.test/v1", "sk-secret-key", "gpt-4o");
    await gateway.complete({ messages: [{ role: "user", text: "患者メモ本文" }], timeoutMs });
  } catch (caught) {
    return caught;
  } finally {
    globalThis.fetch = originalFetch;
  }
  throw new Error("失敗するはずの呼び出しが成功しました");
};

/**
 * 本文を1バイトも送らず、fetchに渡されたsignalが打ち切られた時点で失敗する本文。
 * 実際のfetchは打ち切りを本文の受信にも伝えるので、それをスタブで再現する。
 */
const stalledBody = (signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(streamController) {
      signal?.addEventListener("abort", () => {
        streamController.error(new DOMException("aborted", "AbortError"));
      });
    },
  });

const jsonResponse = (body: unknown, status: number): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/** 失敗をmetaへ変換し、本文やキー・プロンプトが混ざっていないことも併せて確かめる。 */
const metaFrom = async (
  fakeFetch: (init: RequestInit) => Promise<Response>,
  timeoutMs?: number,
): Promise<AiFailureMeta> => {
  const caught = await failureFrom(fakeFetch, timeoutMs);
  expect(caught).toBeInstanceOf(OpenAiRequestError);
  expect(caught).not.toBeInstanceOf(OpenAiRefusalError);
  const meta = aiFailureMeta(caught);
  const serialized = JSON.stringify(meta);
  for (const leaked of ["sk-secret-key", "患者メモ本文", "You exceeded", "<html"]) {
    expect(serialized).not.toContain(leaked);
  }
  return meta;
};

describe("OpenAiGatewayの失敗原因", () => {
  it("429 insufficient_quotaはstatusとcode・typeを残し、messageは残さない", async () => {
    const meta = await metaFrom(() =>
      jsonResponse(
        {
          error: {
            message: "You exceeded your current quota, please check your plan and billing details.",
            type: "insufficient_quota",
            param: null,
            code: "insufficient_quota",
          },
        },
        429,
      ),
    );
    expect(meta).toEqual({
      failureReason: "http_error",
      httpStatus: 429,
      errorCode: "insufficient_quota",
      errorType: "insufficient_quota",
    });
  });

  it("429のレート制限はrate_limit_exceededを残す", async () => {
    const meta = await metaFrom(() =>
      jsonResponse(
        {
          error: {
            message: "Rate limit reached for gpt-4o in organization org-xxx on requests per min",
            type: "requests",
            code: "rate_limit_exceeded",
          },
        },
        429,
      ),
    );
    expect(meta).toEqual({
      failureReason: "http_error",
      httpStatus: 429,
      errorCode: "rate_limit_exceeded",
      errorType: "requests",
    });
  });

  it("500でcode: nullならstatusとtypeだけを残す", async () => {
    const meta = await metaFrom(() =>
      jsonResponse(
        { error: { message: "The server had an error", type: "server_error", code: null } },
        500,
      ),
    );
    expect(meta).toEqual({
      failureReason: "http_error",
      httpStatus: 500,
      errorType: "server_error",
    });
  });

  it("JSONでないエラー本文はstatusだけを残す", async () => {
    const meta = await metaFrom(() =>
      Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );
    expect(meta).toEqual({ failureReason: "http_error", httpStatus: 502 });
  });

  it("本文の無いエラー応答もstatusだけを残す", async () => {
    const meta = await metaFrom(() => Promise.resolve(new Response(null, { status: 503 })));
    expect(meta).toEqual({ failureReason: "http_error", httpStatus: 503 });
  });

  it("8KBを超えるエラー本文は読み切らずに捨て、codeも拾わない", async () => {
    const meta = await metaFrom(() =>
      jsonResponse(
        {
          error: { code: "insufficient_quota", type: "insufficient_quota" },
          padding: `<html${"x".repeat(9_000)}`,
        },
        429,
      ),
    );
    expect(meta).toEqual({ failureReason: "http_error", httpStatus: 429 });
  });

  it("8KBちょうどのエラー本文は読んでcodeを拾う", async () => {
    const head = JSON.stringify({ error: { code: "insufficient_quota" }, padding: "" });
    const body = JSON.stringify({
      error: { code: "insufficient_quota" },
      padding: "x".repeat(8 * 1024 - head.length),
    });
    expect(new TextEncoder().encode(body).length).toBe(8 * 1024);
    const meta = await metaFrom(() => Promise.resolve(new Response(body, { status: 429 })));
    expect(meta).toEqual({
      failureReason: "http_error",
      httpStatus: 429,
      errorCode: "insufficient_quota",
    });
  });

  it("許可文字の外のcodeは落とし、statusは残す", async () => {
    const meta = await metaFrom(() =>
      jsonResponse({ error: { code: "sk-secret-key 氏名", type: "invalid_request_error" } }, 400),
    );
    expect(meta).toEqual({
      failureReason: "http_error",
      httpStatus: 400,
      errorType: "invalid_request_error",
    });
  });

  it("時間内に応答が無ければtimeoutとして残す", async () => {
    const meta = await metaFrom(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      10,
    );
    expect(meta).toEqual({ failureReason: "timeout" });
  });

  it("接続そのものの失敗はnetworkとして残す", async () => {
    const meta = await metaFrom(() => Promise.reject(new TypeError("fetch failed")));
    expect(meta).toEqual({ failureReason: "network" });
  });

  it("ヘッダー受信後に本文の受信が途絶えたらnetworkとして残す", async () => {
    const meta = await metaFrom(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(new TextEncoder().encode('{"choices":'));
              streamController.error(new TypeError("connection reset"));
            },
          }),
          { status: 200 },
        ),
      ),
    );
    expect(meta).toEqual({ failureReason: "network" });
  });

  it("ヘッダー受信後に本文が届かず時間切れになったらtimeoutとして残す", async () => {
    const meta = await metaFrom(
      (init) => Promise.resolve(new Response(stalledBody(init.signal), { status: 200 })),
      10,
    );
    expect(meta).toEqual({ failureReason: "timeout" });
  });

  it("エラーステータスの本文が届かず時間切れになってもhttp_errorとstatusを残す", async () => {
    const meta = await metaFrom(
      (init) => Promise.resolve(new Response(stalledBody(init.signal), { status: 429 })),
      10,
    );
    expect(meta).toEqual({ failureReason: "http_error", httpStatus: 429 });
  });

  it("200でJSONでない本文はinvalid_responseとして残す", async () => {
    const meta = await metaFrom(() =>
      Promise.resolve(new Response("<html>ok</html>", { status: 200 })),
    );
    expect(meta).toEqual({ failureReason: "invalid_response" });
  });

  it("200でschemaに合わない本文はinvalid_responseとして残す", async () => {
    const meta = await metaFrom(() => jsonResponse({ choices: [] }, 200));
    expect(meta).toEqual({ failureReason: "invalid_response" });
  });

  it("refusal無しのcontent: nullもinvalid_responseとして残す", async () => {
    const meta = await metaFrom(() =>
      jsonResponse({ choices: [{ message: { content: null } }] }, 200),
    );
    expect(meta).toEqual({ failureReason: "invalid_response" });
  });

  it("OpenAiRequestError以外の例外はunknownとし、messageを残さない", () => {
    expect(aiFailureMeta(new Error("sk-secret-key"))).toEqual({ failureReason: "unknown" });
    expect(aiFailureMeta("文字列")).toEqual({ failureReason: "unknown" });
  });
});

describe("OpenAiGatewayの本文と互換の接続先", () => {
  /** fetchを差し替えて1回送り、送った本文と結果（成功のtextか投げた例外）を返す。 */
  const sendOnce = async (
    gateway: OpenAiGateway,
    response: () => Response,
  ): Promise<{ bodies: string[]; result: unknown }> => {
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Promise.resolve(response());
    }) as typeof fetch;
    try {
      const result = await gateway
        .complete({ messages: [{ role: "user", text: "こんにちは" }], timeoutMs: 1_000 })
        .then((value) => value.text)
        .catch((caught: unknown) => caught);
      return { bodies, result };
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  const okResponse = (): Response =>
    new Response(JSON.stringify({ choices: [{ message: { content: "了解" } }] }), { status: 200 });

  const parsedBodies = (bodies: readonly string[]): unknown[] =>
    bodies.map((body): unknown => JSON.parse(body));

  it("追加の指定が無ければ、本文はmodelとmessagesだけ（主系の本文を変えない）", async () => {
    const { bodies } = await sendOnce(
      new OpenAiGateway("https://example.test/v1", "k", "gpt-4.1-mini"),
      okResponse,
    );
    expect(bodies).toEqual([
      JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "こんにちは" }],
      }),
    ]);
  });

  it("追加の指定は本文へ足し、modelとmessagesは上書きさせない", async () => {
    const { bodies } = await sendOnce(
      new OpenAiGateway("https://example.test/v1", "k", "claude-haiku-5-5", {
        thinking: { type: "disabled" },
        model: "other-model",
        messages: [],
      }),
      okResponse,
    );
    expect(parsedBodies(bodies)).toEqual([
      {
        thinking: { type: "disabled" },
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: "こんにちは" }],
      },
    ]);
  });

  it("Anthropicの互換の接続先の応答（OpenAIに無い項目つき）から本文を取り出す", async () => {
    // https://platform.claude.com/docs/en/api/openai-sdk の応答の形。
    const anthropicBody = {
      id: "msg_01AbCdEf",
      object: "chat.completion",
      created: 1_791_590_400,
      model: "claude-haiku-5-5",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "承知しました。" },
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    };
    const { result } = await sendOnce(
      new OpenAiGateway("https://api.anthropic.test/v1", "k", "claude-haiku-5-5"),
      () => new Response(JSON.stringify(anthropicBody), { status: 200 }),
    );
    expect(result).toBe("承知しました。");
  });

  it("互換の接続先が空の本文を返したら、応答の形の不一致として失敗にする", async () => {
    const { result } = await sendOnce(
      new OpenAiGateway("https://api.anthropic.test/v1", "k", "claude-haiku-5-5"),
      () =>
        new Response(
          JSON.stringify({
            choices: [{ index: 0, finish_reason: "stop", message: { content: "" } }],
          }),
          { status: 200 },
        ),
    );
    expect(result).toBeInstanceOf(OpenAiRequestError);
    if (!(result instanceof OpenAiRequestError)) throw new Error("unexpected");
    expect(result.failure.reason).toBe("invalid_response");
  });
});
