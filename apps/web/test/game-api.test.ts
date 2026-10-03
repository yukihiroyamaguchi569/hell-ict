import { describe, expect, it } from "vitest";

import { createGameApi } from "../src/api/game-api.js";
import { FakeHttp, ok, sessionBody, viewBody } from "./fakes.js";

const COMMAND_ID = "00000000-0000-4000-8000-000000000001";

describe("createGameApi", () => {
  it("openSession は POST /api/session にチームコードを送り、世代を読む", async () => {
    const http = new FakeHttp(() => ok(sessionBody("123456", 2)));
    const result = await createGameApi(http).openSession("123456");
    expect(http.requests).toEqual([
      { method: "POST", path: "/api/session", body: { teamCode: "123456" } },
    ]);
    expect(result.kind === "ok" && result.value.generation).toBe(2);
  });

  it("fetchGame は GET /api/teams/:code/game を読む", async () => {
    const http = new FakeHttp(() => ok(viewBody(3)));
    const result = await createGameApi(http).fetchGame("654321");
    expect(http.requests).toEqual([{ method: "GET", path: "/api/teams/654321/game" }]);
    expect(result.kind === "ok" && result.value.pos).toBe(3);
  });

  it("fetchGame は processedCommandIds を含む本文を不正として捨てる", async () => {
    const body = viewBody(0);
    const http = new FakeHttp(() =>
      ok({
        ...body,
        state: { ...body.state, game: { ...body.state.game, processedCommandIds: [] } },
      }),
    );
    await expect(createGameApi(http).fetchGame("123456")).resolves.toEqual({
      kind: "invalid-response",
    });
  });

  it("sendCommand はコマンドをそのまま POST .../game/commands へ送る", async () => {
    const http = new FakeHttp(() =>
      ok({ status: "applied", events: [], judgement: null, ...viewBody(1) }),
    );
    const command = { type: "inbox.open", commandId: COMMAND_ID, generation: 0 } as const;
    const result = await createGameApi(http).sendCommand("123456", command);
    expect(http.requests).toEqual([
      { method: "POST", path: "/api/teams/123456/game/commands", body: command },
    ]);
    expect(result.kind === "ok" && result.value.status).toBe("applied");
  });

  it("prepareStageThread は世代を POST .../game/chat/thread へ送り、GET /game と同じ形を読む", async () => {
    const http = new FakeHttp(() => ok(viewBody(2)));
    const result = await createGameApi(http).prepareStageThread("123456", 4);
    expect(http.requests).toEqual([
      {
        method: "POST",
        path: "/api/teams/123456/game/chat/thread",
        body: { type: "prepare-stage-thread", generation: 4 },
      },
    ]);
    expect(result.kind === "ok" && result.value.pos).toBe(2);
  });

  it("prepareStageThread の 503 は http-error のまま返す", async () => {
    const http = new FakeHttp(() => ({ status: 503, body: { message: "会話の準備に失敗" } }));
    const result = await createGameApi(http).prepareStageThread("123456", 0);
    expect(result.kind === "http-error" && result.status).toBe(503);
  });
});
