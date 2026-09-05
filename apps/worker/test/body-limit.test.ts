import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { FakeAiGateway } from "@hell-ict/domain/fakes";
import { createThreadResultSchema } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { DEFAULT_BODY_MAX_BYTES } from "../src/http.js";
import { handleChatMessage } from "../src/index.js";
import { postJson, session, TEST_ORIGIN } from "./support.js";

const CHUNK_BYTES = 4 * 1024;

/**
 * Content-Lengthを申告しない（chunked相当の）本文を作り、実際に読まれたバイト数を数える。
 * `request.text()`は全量を展開してから長さを測るため、上限を超えた本文でも最後まで
 * 読んでしまう。上限付近で読み取りが止まることをここで固定する。
 */
const countingBody = (
  totalBytes: number,
): { stream: ReadableStream<Uint8Array>; read: () => number } => {
  const encoder = new TextEncoder();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK_BYTES, totalBytes - sent);
      sent += size;
      controller.enqueue(encoder.encode("x".repeat(size)));
    },
  });
  return { stream, read: () => sent };
};

const postStream = (path: string, stream: ReadableStream<Uint8Array>): Promise<Response> =>
  exports.default.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      method: "POST",
      body: stream,
      // Content-Lengthを付けないことがこのテストの肝（workerdはduplex指定を要求しない）。
      headers: { Origin: TEST_ORIGIN },
    }),
  );

describe("本文サイズの上限", () => {
  it("Content-Lengthが無くても上限を超えた本文は413で、読み取りが上限付近で止まる", async () => {
    // 上限の8倍を送りつける。全部読まれるなら read() は 8 * 上限になる。
    const total = DEFAULT_BODY_MAX_BYTES * 8;
    const { stream, read } = countingBody(total);

    const response = await postStream("/api/session", stream);

    expect(response.status).toBe(413);
    // 上限を超えた最初のチャンクで打ち切る。ReadableStreamは内部キューへ1つ先読みする
    // ので、実際に生成されるのは上限＋2チャンクまで——全量（上限の8倍）とは桁が違う。
    expect(read()).toBeLessThanOrEqual(DEFAULT_BODY_MAX_BYTES + 2 * CHUNK_BYTES);
    expect(read()).toBeLessThan(total);
  });

  it("Content-Lengthが上限超なら1バイトも読まずに413", async () => {
    const huge = "x".repeat(DEFAULT_BODY_MAX_BYTES + 1);
    const response = await exports.default.fetch(
      new Request(`${TEST_ORIGIN}/api/session`, {
        method: "POST",
        body: huge,
        headers: { Origin: TEST_ORIGIN },
      }),
    );
    expect(response.status).toBe(413);
  });

  it("既定の上限はチャット送信にも効き、AIを呼ばない", async () => {
    await session("500200");
    const created = await postJson("/api/teams/500200/chat/threads", {
      type: "create-thread",
      commandId: "00000000-0000-4000-8000-000000005200",
      title: "副",
    });
    const { snapshot } = createThreadResultSchema.parse(await created.json());
    const threadId = snapshot.threads[0]?.threadId;
    if (threadId === undefined) throw new Error("unexpected");

    const gateway = new FakeAiGateway([{ kind: "success", response: "応答" }]);
    const response = await handleChatMessage(
      new Request(`${TEST_ORIGIN}/api/teams/500200/chat/messages`, {
        method: "POST",
        body: JSON.stringify({
          type: "send-message",
          commandId: "00000000-0000-4000-8000-000000005201",
          threadId,
          text: "x".repeat(40 * 1024),
        }),
      }),
      { env, ctx: createExecutionContext() },
      "500200",
      { aiGateway: gateway, nowMs: Date.now() },
    );

    expect(response.status).toBe(413);
    expect(gateway.requests).toHaveLength(0);
  });

  it("上限以内の本文はこれまでどおり処理される", async () => {
    const response = await postJson("/api/session", { teamCode: "500201" });
    expect(response.status).toBe(200);
  });
});
