import { FakeClock } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";

import { createChatApi } from "../src/api/chat-api.js";
import { chatMessageBody, chatSnapshotBody, FakeHttp, ok, START_MS } from "./fakes.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";

const clock = new FakeClock(new Date(START_MS));

const command = {
  type: "stage-message",
  commandId: ID_A,
  generation: 2,
  text: "斑紋症の対応は？",
} as const;

describe("createChatApi.fetchChat", () => {
  it("未確定IDが無ければ GET /api/teams/:code/chat を問い合わせなしで読む", async () => {
    const http = new FakeHttp(() => ok(chatSnapshotBody(4, { [THREAD]: [] })));
    const result = await createChatApi(http, clock).fetchChat("123456");
    expect(http.requests).toEqual([{ method: "GET", path: "/api/teams/123456/chat" }]);
    expect(result.kind === "ok" && result.value.revision).toBe(4);
  });

  it("空の配列でも問い合わせを付けない", async () => {
    const http = new FakeHttp(() => ok(chatSnapshotBody(0, { [THREAD]: [] })));
    await createChatApi(http, clock).fetchChat("123456", []);
    expect(http.requests[0]?.path).toBe("/api/teams/123456/chat");
  });

  it("未確定IDはカンマで繋いで commandIds に載せ、状態を読む", async () => {
    const http = new FakeHttp(() =>
      ok(chatSnapshotBody(1, { [THREAD]: [] }, { [ID_A]: "processed", [ID_B]: "unknown" })),
    );
    const result = await createChatApi(http, clock).fetchChat("123456", [ID_A, ID_B]);
    const path = http.requests[0]?.path ?? "";
    expect(new URL(path, "http://x").searchParams.get("commandIds")).toBe(`${ID_A},${ID_B}`);
    expect(path.startsWith("/api/teams/123456/chat?")).toBe(true);
    expect(result.kind === "ok" && result.value.commands).toEqual({
      [ID_A]: "processed",
      [ID_B]: "unknown",
    });
  });

  it("スレッドが1本も無い応答は schema 外なので invalid-response", async () => {
    const http = new FakeHttp(() => ok({ teamCode: "123456", revision: 0, threads: [] }));
    await expect(createChatApi(http, clock).fetchChat("123456")).resolves.toEqual({
      kind: "invalid-response",
    });
  });

  it("503 は http-error", async () => {
    const http = new FakeHttp(() => ({ status: 503, body: { message: "取得に失敗" } }));
    const result = await createChatApi(http, clock).fetchChat("123456");
    expect(result.kind === "http-error" && result.status).toBe(503);
  });
});

describe("createChatApi.sendStageMessage", () => {
  const reply = {
    snapshot: chatSnapshotBody(3, {
      [THREAD]: [
        chatMessageBody(1, "user", "斑紋症の対応は？"),
        chatMessageBody(2, "assistant", "はい"),
      ],
    }),
    assistant: chatMessageBody(2, "assistant", "はい"),
  };

  it("コマンドをそのまま POST .../game/chat/messages へ送り、snapshot と assistant を読む", async () => {
    const http = new FakeHttp(() => ok(reply));
    const result = await createChatApi(http, clock).sendStageMessage("123456", command);
    expect(http.requests).toEqual([
      { method: "POST", path: "/api/teams/123456/game/chat/messages", body: command },
    ]);
    expect(result.kind === "ok" && result.value.assistant.text).toBe("はい");
  });

  it("assistant が欠けた 200 は invalid-response（成功扱いにしない）", async () => {
    const http = new FakeHttp(() => ok({ snapshot: reply.snapshot }));
    await expect(createChatApi(http, clock).sendStageMessage("123456", command)).resolves.toEqual({
      kind: "invalid-response",
    });
  });

  it("429 は Retry-After の秒数つきの http-error", async () => {
    const http = new FakeHttp(() => ({
      status: 429,
      body: { message: "送信が多すぎます。少し待ってから再試行してください。" },
      retryAfter: "15",
    }));
    const result = await createChatApi(http, clock).sendStageMessage("123456", command);
    expect(result.kind === "http-error" && result.retryAfterSeconds).toBe(15);
  });

  it("429 の Retry-After が日付なら、渡した clock の今からの秒数", async () => {
    const at = new Date(START_MS + 20_000).toUTCString();
    const http = new FakeHttp(() => ({ status: 429, body: null, retryAfter: at }));
    const result = await createChatApi(http, clock).sendStageMessage("123456", command);
    expect(result.kind === "http-error" && result.retryAfterSeconds).toBe(20);
  });

  it("422 pii_blocked の code を読む", async () => {
    const http = new FakeHttp(() => ({
      status: 422,
      body: { message: "個人情報を検知したため、送信をブロックしました。", code: "pii_blocked" },
    }));
    const result = await createChatApi(http, clock).sendStageMessage("123456", command);
    expect(result.kind === "http-error" && result.error?.code).toBe("pii_blocked");
  });

  it("通信断は network-error", async () => {
    const http = new FakeHttp(() => {
      throw new Error("offline");
    });
    await expect(createChatApi(http, clock).sendStageMessage("123456", command)).resolves.toEqual({
      kind: "network-error",
    });
  });
});
