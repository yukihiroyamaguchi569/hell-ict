import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { handleGameStandings } from "../src/game-api.js";
import { GameStore } from "../src/game-store.js";
import { progressSchemaSql } from "../src/progress.js";
import { advance, applied, CLEAR, command, playTo, send } from "./game-command-support.js";
import { clock, countRows, gameOf, gmReset } from "./game-support.js";
import { get, session } from "./support.js";

beforeEach(() => {
  clock.reset();
});

const progressRows = async (teamCode: string) => {
  const rows = await env.PROGRESS_DB.prepare(
    "SELECT pos, view, kind, team_name, generation, client_at FROM progress_events WHERE team_code = ? ORDER BY id",
  )
    .bind(teamCode)
    .all();
  return z
    .array(
      z.object({
        pos: z.number(),
        view: z.string(),
        kind: z.string(),
        team_name: z.string(),
        generation: z.number(),
        client_at: z.string(),
      }),
    )
    .parse(rows.results);
};

const standingsSchema = z.object({
  entries: z.array(
    z
      .object({
        marker: z.string(),
        isSelf: z.boolean(),
        stage: z.string(),
        pos: z.number(),
        reachedAt: z.string(),
        finishedAt: z.string().nullable(),
      })
      .strict(),
  ),
});

const standingsFor = async (teamCode: string) => {
  const response = await handleGameStandings(env, teamCode);
  expect(response.status).toBe(200);
  return standingsSchema.parse(await response.json()).entries;
};

/** 帯の中で自分が何番目か（見つからなければ-1）。 */
const rankOf = async (teamCode: string): Promise<number> =>
  (await standingsFor(teamCode)).findIndex((entry) => entry.isSelf);

describe("APIだけでPrologueからFinalまで通す", () => {
  it("正解の提出で全ステージをクリアし、Finalへ入った時刻がゴールとして進捗と帯に載る", async () => {
    const teamCode = "910001";
    await playTo(teamCode, "final");
    const goalAt = new Date(clock.now().getTime() - 1_000).toISOString();
    const view = await gameOf(teamCode);
    expect(view.state.game.stage).toBe("final");
    expect(Object.keys(view.state.game.clearedAt)).toEqual([
      "prologue",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
    ]);
    expect(view.state.game.penalties).toEqual({ s3: "none", s5: "none" });
    expect(view.state.enteredAt.final).toBe(goalAt);
    expect(view.pos).toBe(7);

    // 進捗（ダッシュボード）: クリアは次の停留所、前進は入ったステージの停留所で積む。
    const rows = await progressRows(teamCode);
    expect(rows.map((row) => [row.kind, row.pos, row.view])).toEqual([
      ["clear", 1, "inbox"],
      ["entry", 1, "s1"],
      ["clear", 2, "s1"],
      ["entry", 2, "s2"],
      ["clear", 3, "s2"],
      ["entry", 3, "s3"],
      ["clear", 4, "s3"],
      ["entry", 4, "s4"],
      ["clear", 5, "s4"],
      ["entry", 5, "s5"],
      ["clear", 6, "s5"],
      ["entry", 6, "s6"],
      ["clear", 7, "s6"],
      ["entry", 7, "final"],
    ]);
    expect(rows.every((row) => row.team_name === "" && row.generation === 0)).toBe(true);
    expect(rows.at(-1)?.client_at).toBe(goalAt);

    // 帯: ゴールの時刻が載る。
    const mine = (await standingsFor(teamCode)).find((entry) => entry.isSelf);
    expect(mine).toEqual({
      marker: expect.stringMatching(/^チーム\d+$/),
      isSelf: true,
      stage: "final",
      pos: 7,
      reachedAt: view.state.game.clearedAt.s6,
      finishedAt: goalAt,
    });
  });

  it("ダッシュボードの集計（GET /api/progress/summary）にも、サーバが積んだ位置が出る", async () => {
    const teamCode = "910002";
    await playTo(teamCode, "s2");
    const response = await get("/api/progress/summary");
    expect(response.status).toBe(200);
    const body = z
      .object({ teams: z.array(z.object({ pos: z.number(), isSelf: z.boolean().optional() })) })
      .parse(await response.json());
    expect(body.teams.some((team) => team.pos === 2)).toBe(true);
  });

  it("停留所の動かないコマンド・拒否・再送は、進捗も帯も書かない", async () => {
    const teamCode = "910003";
    await applied(teamCode, command("inbox.open"));
    const body = command("inbox.reply", { mailId: "p0", text: "了解" });
    await applied(teamCode, body);
    expect((await send(teamCode, body)).status).toBe("duplicate");
    expect((await send(teamCode, command("inbox.settle"))).status).toBe("rejected");
    expect(await progressRows(teamCode)).toEqual([]);
    expect(await rankOf(teamCode)).toBe(-1);
  });
});

describe("順位（ゴール時刻と、同じ停留所の中はクリアの早い順）", () => {
  it("後からクリアしたチームは、先に次のステージへ入っても前へ出ない（#159）", async () => {
    const early = "920001";
    const late = "920002";
    await CLEAR.prologue?.(early);
    clock.advanceBy(1_000);
    await CLEAR.prologue?.(late);
    clock.advanceBy(1_000);
    // 後からクリアした側が先に前進し、先にクリアした側は余韻の後で前進する。
    await applied(late, advance("prologue", "s1"));
    clock.advanceBy(30_000);
    await applied(early, advance("prologue", "s1"));
    expect(await rankOf(early)).toBeLessThan(await rankOf(late));
    const entries = await standingsFor(early);
    expect(entries[await rankOf(early)]).toMatchObject({ pos: 1, stage: "s1", finishedAt: null });
  });

  it("Finalへ入ったチームは、停留所の同じ未ゴールのチームより前に並ぶ", async () => {
    const finisher = "920003";
    const waiting = "920004";
    await playTo(waiting, "s6");
    await CLEAR.s6?.(waiting);
    await playTo(finisher, "final");
    expect(await rankOf(finisher)).toBeLessThan(await rankOf(waiting));
    const entries = await standingsFor(waiting);
    expect(entries[await rankOf(waiting)]).toMatchObject({ pos: 7, stage: "s6", finishedAt: null });
  });

  it("ルーティング経由（GET /game/leaderboard）でも読め、チームコードは返さない", async () => {
    await CLEAR.prologue?.("920005");
    const response = await get("/api/teams/920005/game/leaderboard");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("920005");
    expect(standingsSchema.parse(JSON.parse(text)).entries.some((e) => e.isSelf)).toBe(true);
  });
});

describe("帯への反映の失敗と送り直し", () => {
  it("帯が落ちていてもコマンドは通り、印が残って次のGETで送り直す", async () => {
    const teamCode = "930001";
    await CLEAR.prologue?.(teamCode);
    // 印（game_standing_outbox）が残っている状態を作る: 帯側の行を消し、印を立て直す。
    await runInDurableObject(env.RACE_LEADERBOARD.getByName("global"), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM game_standings WHERE team_code = ?", teamCode);
    });
    await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO game_standing_outbox (id, generation, seq) VALUES (1, 0, 1)",
      );
    });
    expect(await rankOf(teamCode)).toBe(-1);
    await gameOf(teamCode);
    expect(await rankOf(teamCode)).toBeGreaterThanOrEqual(0);
    await expect(countRows(teamCode, "game_standing_outbox")).resolves.toBe(0);
  });

  it("進捗（D1）へ積めなかった遷移はDOに残り、D1が戻ったら次のGETで積む", async () => {
    const teamCode = "930003";
    // 先に1回積んで、進捗の表を作る処理（ensureSchema）を済ませておく。
    await CLEAR.prologue?.(teamCode);
    expect(await progressRows(teamCode)).toHaveLength(1);
    await env.PROGRESS_DB.exec("DROP TABLE progress_events");
    const reply = await applied(teamCode, advance("prologue", "s1"));
    expect(reply.state.game.stage).toBe("s1");
    await expect(countRows(teamCode, "game_progress_outbox")).resolves.toBe(1);

    await env.PROGRESS_DB.exec(progressSchemaSql);
    await gameOf(teamCode);
    await expect(countRows(teamCode, "game_progress_outbox")).resolves.toBe(0);
    expect((await progressRows(teamCode)).map((row) => [row.kind, row.pos, row.view])).toEqual([
      ["entry", 1, "s1"],
    ]);
  });

  it("リセット前の世代の送信が遅れて終わっても、新しい世代の送信待ちを消さない", async () => {
    const teamCode = "930004";
    await gameOf(teamCode);
    const left = await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_i, state) => {
      const old = new GameStore(state.storage, 0);
      state.storage.sql.exec(
        "INSERT INTO game_progress_outbox (generation, events) VALUES (0, '[]'), (0, '[]')",
      );
      state.storage.sql.exec(
        "INSERT INTO game_standing_outbox (id, generation, seq) VALUES (1, 0, 5)",
      );
      const pending = old.pendingProgress();
      // ここでGMリセットが入り、新しい世代の遷移が積まれる（行番号とseqは振り直される）。
      state.storage.sql.exec("DELETE FROM game_progress_outbox");
      state.storage.sql.exec("DELETE FROM game_standing_outbox");
      state.storage.sql.exec(
        "INSERT INTO game_progress_outbox (generation, events) VALUES (1, '[]')",
      );
      state.storage.sql.exec(
        "INSERT INTO game_standing_outbox (id, generation, seq) VALUES (1, 1, 1)",
      );
      old.clearProgress(pending?.lastId ?? 0);
      old.clearPendingStanding(5);
      return {
        progress: state.storage.sql.exec("SELECT generation FROM game_progress_outbox").toArray(),
        standing: state.storage.sql.exec("SELECT generation FROM game_standing_outbox").toArray(),
        oldSees: old.pendingProgress(),
        newSees: new GameStore(state.storage, 1).pendingProgress()?.lastId ?? null,
      };
    });
    expect(left.progress).toEqual([{ generation: 1 }]);
    expect(left.standing).toEqual([{ generation: 1 }]);
    expect(left.oldSees).toBeNull();
    expect(left.newSees).toBe(1);
  });

  it("時計が前後して届いても、クリア・入場の時刻は適用の順に並ぶ", async () => {
    const teamCode = "930005";
    clock.advanceBy(60_000);
    await CLEAR.prologue?.(teamCode);
    const clearedAt = (await gameOf(teamCode)).state.game.clearedAt.prologue;
    // 先に読まれた（遅い）時刻の前進が、後から適用される。
    clock.reset();
    const reply = await applied(teamCode, advance("prologue", "s1"));
    expect(reply.state.enteredAt.s1).toBe(clearedAt);
  });

  it("GETが帯・進捗への送信を待つ間に適用されたコマンドも、GETの応答に含まれる", async () => {
    const teamCode = "930006";
    await gameOf(teamCode);
    const command_ = command("inbox.open");
    const [{ state }] = await runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (instance) =>
      // GETが送信を待っている間に、同じDOへコマンドが入る順序を作る。
      Promise.all([
        instance.gameState(teamCode, clock.now().getTime()),
        instance.applyGameCommand(teamCode, command_, clock.now().getTime(), "0".repeat(64)),
      ]),
    );
    expect(state.inbox).not.toBeNull();
  });

  it("古いseqの反映は新しい位置を上書きしない", async () => {
    const teamCode = "930002";
    await playTo(teamCode, "s1");
    const newest = (await standingsFor(teamCode)).find((entry) => entry.isSelf);
    await env.RACE_LEADERBOARD.getByName("global").recordStanding(
      teamCode,
      { stage: "prologue", pos: 0, reachedAt: "2026-10-31T00:00:00.000Z", finishedAt: null },
      0,
      0,
    );
    expect((await standingsFor(teamCode)).find((entry) => entry.isSelf)).toEqual(newest);
  });
});

describe("GMリセット", () => {
  it("帯の位置と反映待ちの印も消え、リセット後の世代の進捗だけが数えられる", async () => {
    const teamCode = "940001";
    await session(teamCode);
    await playTo(teamCode, "s2");
    expect(await rankOf(teamCode)).toBeGreaterThanOrEqual(0);
    expect((await gmReset(teamCode)).status).toBe(200);
    expect(await rankOf(teamCode)).toBe(-1);
    await expect(countRows(teamCode, "game_standing_outbox")).resolves.toBe(0);
    await applied(teamCode, command("inbox.open", {}, 1));
    await applied(teamCode, command("inbox.reply", { mailId: "p0", text: "a" }, 1));
    await applied(teamCode, command("inbox.reply", { mailId: "p1", text: "a" }, 1));
    await applied(teamCode, command("inbox.reply", { mailId: "p2", text: "a" }, 1));
    const rows = await progressRows(teamCode);
    expect(rows.at(-1)).toMatchObject({ kind: "clear", pos: 1, generation: 1 });
    expect(await rankOf(teamCode)).toBeGreaterThanOrEqual(0);
  });
});
