import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { GamePublisher } from "../src/game-publish.js";
import { GameStore } from "../src/game-store.js";
import { progressSchemaSql } from "../src/progress.js";
import { advance, applied, CLEAR } from "./game-command-support.js";
import { clock, countRows } from "./game-support.js";

beforeEach(() => {
  clock.reset();
});

const entryRows = async (teamCode: string): Promise<number> => {
  const row = await env.PROGRESS_DB.prepare(
    "SELECT COUNT(*) AS n FROM progress_events WHERE team_code = ? AND kind = 'entry'",
  )
    .bind(teamCode)
    .first();
  return z.object({ n: z.number() }).parse(row).n;
};

/**
 * Leaves one progress transition (prologue -> s1) unsent in the DO's outbox: the progress
 * table is dropped while the command is applied, so TeamRoom's own send fails and keeps it.
 */
const leaveUnsentEntry = async (teamCode: string): Promise<void> => {
  await CLEAR.prologue?.(teamCode);
  await env.PROGRESS_DB.exec("DROP TABLE progress_events");
  await applied(teamCode, advance("prologue", "s1"));
  await expect(countRows(teamCode, "game_progress_outbox")).resolves.toBe(1);
};

describe("GamePublisher（帯・進捗・活動ログの送信）", () => {
  it("同じインスタンスへの同時の送信は1本ずつ走り、同じ遷移を二重に積まない", async () => {
    const teamCode = "940001";
    await leaveUnsentEntry(teamCode);
    await env.PROGRESS_DB.exec(progressSchemaSql);
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (_instance, state) => {
      const publisher = new GamePublisher(env);
      const store = new GameStore(state.storage, 0);
      await Promise.all([publisher.publish(teamCode, store), publisher.publish(teamCode, store)]);
    });
    expect(await entryRows(teamCode)).toBe(1);
    await expect(countRows(teamCode, "game_progress_outbox")).resolves.toBe(0);
  });

  it("インスタンスが別々だと列も別になり、同じ遷移を二重に積む（DOに1つだけ持つ理由）", async () => {
    const teamCode = "940002";
    await leaveUnsentEntry(teamCode);
    await env.PROGRESS_DB.exec(progressSchemaSql);
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (_instance, state) => {
      const store = new GameStore(state.storage, 0);
      await Promise.all([
        new GamePublisher(env).publish(teamCode, store),
        new GamePublisher(env).publish(teamCode, store),
      ]);
    });
    expect(await entryRows(teamCode)).toBe(2);
  });

  it("送信の失敗は握って行を残し、同じ列の次の送信で積む（列が止まらない）", async () => {
    const teamCode = "940003";
    await leaveUnsentEntry(teamCode);
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), async (_instance, state) => {
      const publisher = new GamePublisher(env);
      const store = new GameStore(state.storage, 0);
      await publisher.publish(teamCode, store);
      expect(store.pendingProgress()?.events).toHaveLength(1);

      await env.PROGRESS_DB.exec(progressSchemaSql);
      await publisher.publish(teamCode, store);
      expect(store.pendingProgress()).toBeNull();
    });
    expect(await entryRows(teamCode)).toBe(1);
  });
});
