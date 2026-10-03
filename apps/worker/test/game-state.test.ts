import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { RESET_KEPT_TABLES, RESET_TABLES } from "../src/team-room-schema.js";
import {
  clock,
  countRows,
  gameOf,
  gmReset,
  START,
  teamRoomTables,
  viewSchema,
} from "./game-support.js";
import { get, session } from "./support.js";

beforeEach(() => {
  clock.reset();
});

describe("GET /api/teams/:code/game", () => {
  it("初回は、その時刻に始まるPrologueの初期状態（pos 0）とサーバの時刻を返す", async () => {
    const view = await gameOf("810001");
    expect(view.state.game).toEqual({
      stage: "prologue",
      clearedAt: {},
      penalties: { s3: "none", s5: "none" },
    });
    expect(view.state).toMatchObject({
      startedAt: START.toISOString(),
      enteredAt: {},
      inbox: null,
      s1: null,
      s2: null,
      s4: { summaryAccepted: false },
      s6: { promptLog: [], candidates: [] },
    });
    // D1の処理済みcommandIdの一覧は台帳の内側の都合なので、画面へは出さない。
    expect(view.state.game).not.toHaveProperty("processedCommandIds");
    expect(view.pos).toBe(0);
    expect(view.serverNow).toBe(START.getTime());
  });

  it("再接続（GETのやり直し）では、時刻が進んでも同じ状態を返す（開始時刻は最初のまま）", async () => {
    const first = await gameOf("810002");
    clock.advanceBy(60_000);
    const second = await gameOf("810002");
    expect(second.state).toEqual(first.state);
    expect(second.serverNow).toBe(START.getTime() + 60_000);
    await expect(countRows("810002", "game_state")).resolves.toBe(1);
  });

  it("ルーティング経由でも読める（入口ガードを通る同一オリジンのGET）", async () => {
    const response = await get("/api/teams/810003/game");
    expect(response.status).toBe(200);
    expect(viewSchema.parse(await response.json()).state.game.stage).toBe("prologue");
  });

  it("保存された状態が壊れていたら503で、初期状態へ読み替えない", async () => {
    await gameOf("810004");
    await runInDurableObject(env.TEAM_ROOM.getByName("810004"), (_instance, state) => {
      state.storage.sql.exec("UPDATE game_state SET state = '{\"broken\":true}' WHERE id = 1");
    });
    const response = await get("/api/teams/810004/game");
    expect(response.status).toBe(503);
    const raw = await runInDurableObject(env.TEAM_ROOM.getByName("810004"), (_instance, state) =>
      String(state.storage.sql.exec("SELECT state FROM game_state").one().state),
    );
    expect(raw).toBe('{"broken":true}');
  });
});

describe("GMリセット", () => {
  it("ゲーム状態のテーブルも空にし、次のGETは新しい開始時刻で作り直す", async () => {
    await session("810011");
    await gameOf("810011");
    await expect(countRows("810011", "game_state")).resolves.toBe(1);
    expect((await gmReset("810011")).status).toBe(200);
    await expect(countRows("810011", "game_state")).resolves.toBe(0);
    clock.advanceBy(5_000);
    const view = await gameOf("810011");
    expect(view.state.startedAt).toBe(new Date(START.getTime() + 5_000).toISOString());
  });

  it("RESET_TABLESは、DOが作るテーブルのうちリセットで残すもの以外をすべて含む", async () => {
    await gameOf("810012");
    const tables = await teamRoomTables("810012");
    const covered: readonly string[] = [...RESET_TABLES, ...RESET_KEPT_TABLES];
    expect(tables.filter((table) => !covered.includes(table))).toEqual([]);
    // 逆向き: 一覧にあるのに作られていないテーブルも無い（名前の打ち間違いで消し忘れない）。
    expect(covered.filter((table) => !tables.includes(table))).toEqual([]);
  });
});
