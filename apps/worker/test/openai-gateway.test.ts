import { describe, expect, it } from "vitest";

import { OpenAiGateway } from "../src/openai-gateway.js";

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

  it("HTTPエラー応答は例外として伝える", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response("rate limited", { status: 429 }))) as typeof fetch;
    try {
      const gateway = new OpenAiGateway("https://example.test/v1", "secret-key", "gpt-4o");
      await expect(
        gateway.complete({ messages: [{ role: "user", text: "test" }], timeoutMs: 1_000 }),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ポリシー拒否（content: null, refusal）はrefusalの内容を含む例外として伝える", async () => {
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
