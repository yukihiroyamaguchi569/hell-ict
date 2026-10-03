import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { FakeClock } from "@hell-ict/domain/fakes";
import { expect } from "vitest";
import { z } from "zod";

import { handleGameState } from "../src/game-api.js";
import { TEST_ORIGIN } from "./support.js";

/**
 * ゲーム状態のAPI（Issue #234）のテスト用の道具。締切や到達時刻を扱うので、ハンドラへ
 * Fake Clockを渡して呼ぶ（ルーティングはexports.default.fetch経由の数本で確かめる）。
 * DOとD1は本物を使う。
 */

export const START = new Date("2026-10-31T01:00:00.000Z");

let current = new FakeClock(START);

/** テスト全体で共有するFake Clock。各テストの前に`reset()`で開始時刻へ戻す。 */
export const clock = {
  now: (): Date => current.now(),
  advanceBy: (milliseconds: number): void => {
    current.advanceBy(milliseconds);
  },
  reset: (): void => {
    current = new FakeClock(START);
  },
};

export const viewSchema = z.object({
  state: z
    .object({
      game: z
        .object({
          stage: z.string(),
          clearedAt: z.record(z.string(), z.string()),
          penalties: z.object({ s3: z.string(), s5: z.string() }),
        })
        .strict(),
      startedAt: z.string(),
      enteredAt: z.record(z.string(), z.string()),
    })
    .loose(),
  pos: z.number(),
  serverNow: z.number(),
});

export const gameOf = async (teamCode: string): Promise<z.infer<typeof viewSchema>> => {
  const response = await handleGameState(env, teamCode, clock);
  expect(response.status).toBe(200);
  return viewSchema.parse(await response.json());
};

/** DOのテーブル（Cloudflareの内部テーブルを除く）の名前。 */
export const teamRoomTables = (teamCode: string): Promise<string[]> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) =>
    state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
      .toArray()
      .map((row) => String(row.name)),
  );

export const countRows = (teamCode: string, table: string): Promise<number> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) =>
    Number(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n),
  );

const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";

/** ゲームマスターのリセット。ADMIN_TOKENはこの呼び出しの間だけ差し替える。 */
export const gmReset = async (teamCode: string): Promise<Response> => {
  const saved = env.ADMIN_TOKEN;
  Object.assign(env, { ADMIN_TOKEN });
  try {
    return await exports.default.fetch(
      new Request(`${TEST_ORIGIN}/api/gm/teams/${teamCode}/reset`, {
        method: "POST",
        headers: { Origin: TEST_ORIGIN, Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
  } finally {
    Object.assign(env, { ADMIN_TOKEN: saved });
  }
};
