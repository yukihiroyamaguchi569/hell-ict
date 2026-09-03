import { env, exports } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import {
  chatSnapshotSchema,
  leaderboardSnapshotSchema,
  teamSnapshotSchema,
  teamSyncMessageSchema,
} from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { firstMessage, get, postJson, session, upgrade } from "./support.js";

describe("P1B Worker", () => {
  it("health checkはDOを作らず固定の成功応答を返す", async () => {
    await expect(listDurableObjectIds(env.TEAM_ROOM)).resolves.toEqual([]);
    await expect(listDurableObjectIds(env.RACE_LEADERBOARD)).resolves.toEqual([]);

    const response = await exports.default.fetch(new Request("https://example.test/api/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    await expect(listDurableObjectIds(env.TEAM_ROOM)).resolves.toEqual([]);
    await expect(listDurableObjectIds(env.RACE_LEADERBOARD)).resolves.toEqual([]);
  });

  it("6桁コードで初期状態を作成し、同じコードでは復元する", async () => {
    const first = await session("000000");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      teamCode: "000000",
      revision: 0,
      state: {
        stage: "prologue",
        mode: "peace",
        metrics: { occupancy: 398, capacity: 400, availableBeds: 2, unknownFever: 3 },
      },
    });
    const again = await session("000000");
    await expect(again.json()).resolves.toMatchObject({
      teamCode: "000000",
      revision: 0,
      state: { stage: "prologue" },
    });
  });

  it("重複commandIdを一度だけ適用する", async () => {
    await session("000001");
    const command = {
      type: "enter-stage1",
      commandId: "00000000-0000-4000-8000-000000000001",
      expectedRevision: 0,
    };
    const endpoint = "/api/teams/000001/commands";
    const first = await postJson(endpoint, command);
    const repeated = await postJson(endpoint, command);
    await expect(first.json()).resolves.toMatchObject({
      applied: true,
      leaderboardPending: false,
      snapshot: { revision: 1, state: { stage: "stage1" } },
    });
    await expect(repeated.json()).resolves.toMatchObject({
      applied: true,
      leaderboardPending: false,
      snapshot: { revision: 1, state: { stage: "stage1" } },
    });
  });

  it("不正な入力と競合は状態を変えずに拒否する", async () => {
    expect((await session("１２３４５６")).status).toBe(400);
    await session("000002");
    const endpoint = "/api/teams/000002/commands";
    const invalid = await postJson(endpoint, {
      type: "enter-stage1",
      commandId: "00000000-0000-4000-8000-000000000002",
      expectedRevision: 0.5,
    });
    const stale = await postJson(endpoint, {
      type: "enter-stage1",
      commandId: "00000000-0000-4000-8000-000000000003",
      expectedRevision: 1,
    });
    expect(invalid.status).toBe(400);
    expect(stale.status).toBe(409);
    await expect((await session("000002")).json()).resolves.toMatchObject({
      revision: 0,
      state: { stage: "prologue" },
    });
  });

  it("syncはWebSocket Upgrade以外の要求を426で拒否する", async () => {
    const team = await get("/api/teams/000003/sync");
    const leaderboard = await get("/api/leaderboard/sync?teamCode=000003");
    expect(team.status).toBe(426);
    expect(leaderboard.status).toBe(426);
  });

  it("チームsyncは101で切り替わり、初回メッセージでteam envelopeを配信する", async () => {
    await session("000003");
    const response = await upgrade("/api/teams/000003/sync");
    expect(response.status).toBe(101);
    const envelope = teamSyncMessageSchema.parse(await firstMessage(response));
    expect(envelope.kind).toBe("team");
    if (envelope.kind !== "team") throw new Error("unexpected");
    expect(teamSnapshotSchema.parse(envelope.snapshot)).toMatchObject({
      teamCode: "000003",
      revision: 0,
      state: { stage: "prologue" },
    });
  });

  it("リーダーボードsyncは101で切り替わり、チームコードを配信に含めない", async () => {
    await session("000004");
    const response = await upgrade("/api/leaderboard/sync?teamCode=000004");
    expect(response.status).toBe(101);
    const message = leaderboardSnapshotSchema.parse(await firstMessage(response));
    const self = message.entries.filter((entry) => entry.isSelf);
    expect(self).toMatchObject([{ stage: "prologue", teamRevision: 0 }]);
  });

  it("GET /api/teams/{code}/chatは200でchatSnapshot形状を返す", async () => {
    await session("000005");
    const response = await get("/api/teams/000005/chat");
    expect(response.status).toBe(200);
    const snapshot = chatSnapshotSchema.parse(await response.json());
    expect(snapshot).toMatchObject({ teamCode: "000005", threads: [{ title: "メイン" }] });
  });

  it("不正なsync要求はTeamRoomを増やさずに拒否する", async () => {
    const before = (await listDurableObjectIds(env.TEAM_ROOM)).length;
    const invalidQuery = await upgrade("/api/leaderboard/sync?teamCode=12345");
    const invalidPath = await upgrade("/api/teams/12345/sync");
    expect(invalidQuery.status).toBe(400);
    expect(invalidPath.status).toBe(404);
    await expect(listDurableObjectIds(env.TEAM_ROOM)).resolves.toHaveLength(before);
  });
});
