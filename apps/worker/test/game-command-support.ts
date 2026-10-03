import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import {
  stage1Answers,
  stage3Answers,
  stage4Answers,
  stage5Answers,
  stage6Answers,
} from "@hell-ict/content/answers";
import { expect } from "vitest";
import { z } from "zod";

import { handleGameCommand } from "../src/game-api.js";
import { clock, viewSchema } from "./game-support.js";
import { TEST_ORIGIN } from "./support.js";

/** ゲームのコマンド（POST /api/teams/:code/game/commands）のテスト用の道具。 */

const eventSchema = z.object({ type: z.string(), stage: z.string(), at: z.string() }).strict();

export const replySchema = viewSchema.extend({
  status: z.enum(["applied", "rejected", "duplicate"]),
  reason: z.string().optional(),
  events: z.array(eventSchema).optional(),
  judgement: z.unknown(),
  original: z.object({ events: z.array(eventSchema), judgement: z.unknown() }).optional(),
});

export type Reply = z.infer<typeof replySchema>;

/** 画面が送る形のコマンド。commandIdは毎回新しく振る（世代は既定で0）。 */
export const command = (type: string, payload: Record<string, unknown> = {}, generation = 0) => ({
  type,
  commandId: crypto.randomUUID(),
  generation,
  ...payload,
});

export const advance = (from: string, to: string, generation = 0) =>
  command("advance", { from, to }, generation);

export const postCommand = (teamCode: string, body: unknown): Promise<Response> =>
  handleGameCommand(
    new Request(`${TEST_ORIGIN}/api/teams/${teamCode}/game/commands`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { env, ctx: createExecutionContext() },
    teamCode,
    clock,
  );

export const send = async (teamCode: string, body: unknown): Promise<Reply> => {
  const response = await postCommand(teamCode, body);
  expect(response.status).toBe(200);
  return replySchema.parse(await response.json());
};

export const applied = async (teamCode: string, body: unknown): Promise<Reply> => {
  const reply = await send(teamCode, body);
  expect(reply, JSON.stringify(reply.reason)).toMatchObject({ status: "applied" });
  return reply;
};

export const POLITE_REPLY = stage1Answers.politeReply;

/** Stage 2 の判定をすべて通る20行（中身の照合は無い）。 */
export const GOOD_GRID = Array.from({ length: 20 }, (_, i) => [
  String(i + 1),
  "5A",
  "2026-08-01",
  "陰性",
  "なし",
  "",
]);

export const STAGE3_OK = stage3Answers.ok;

export const STAGE3_TRAP = { ...STAGE3_OK, ppe: stage3Answers.trap.ppe };

/** 整えた発熱患者一覧: 全ID・日付の書式は1種類・体温はすべて単位つき。 */
export const STAGE5_LIST = stage5Answers.cleanList;

/** 各ステージを正解の提出で抜ける。時計はステージの中で進める。世代はGMリセット後に1以上を渡す。 */
export const CLEAR: Record<string, (teamCode: string, generation?: number) => Promise<void>> = {
  prologue: async (teamCode, generation = 0) => {
    await applied(teamCode, command("inbox.open", {}, generation));
    clock.advanceBy(10_000);
    for (const mailId of ["p0", "p1", "p2"]) {
      await applied(
        teamCode,
        command("inbox.reply", { mailId, text: "承知しました。" }, generation),
      );
    }
  },
  s1: async (teamCode, generation = 0) => {
    await applied(teamCode, command("s1.start", {}, generation));
    // 1ラウンド目の最後のメールは開始から23秒で届く。5通とも丁寧に返す。
    clock.advanceBy(24_000);
    for (const mailId of ["m1", "m2", "m3", "m4", "m8"]) {
      await applied(teamCode, command("s1.reply", { mailId, text: POLITE_REPLY }, generation));
    }
  },
  s2: async (teamCode, generation = 0) => {
    await applied(teamCode, command("s2.start", {}, generation));
    clock.advanceBy(120_000);
    await applied(teamCode, command("s2.submit", { grid: GOOD_GRID }, generation));
  },
  s3: async (teamCode, generation = 0) => {
    await applied(teamCode, command("s3.submit", { submission: STAGE3_OK }, generation));
  },
  s4: async (teamCode, generation = 0) => {
    await applied(
      teamCode,
      command("s4.submit-summary", { text: stage4Answers.summaryOk }, generation),
    );
    await applied(
      teamCode,
      command("s4.submit-action", { text: stage4Answers.actionOk }, generation),
    );
  },
  s5: async (teamCode, generation = 0) => {
    await applied(teamCode, command("s5.submit", { text: STAGE5_LIST }, generation));
  },
  s6: async (teamCode, generation = 0) => {
    await applied(teamCode, command("s6.generate", { prompt: stage6Answers.promptOk }, generation));
    await applied(teamCode, command("s6.submit", { candidateIndex: 0 }, generation));
  },
};

export const ORDER = ["prologue", "s1", "s2", "s3", "s4", "s5", "s6", "final"] as const;

/** 正規のルートで`target`へ入ったところまで進める。クリアの後、5秒の余韻を置いて前進する。 */
export const playTo = async (
  teamCode: string,
  target: (typeof ORDER)[number],
  generation = 0,
): Promise<void> => {
  for (const [index, stage] of ORDER.entries()) {
    if (stage === target) return;
    await CLEAR[stage]?.(teamCode, generation);
    clock.advanceBy(5_000);
    await applied(teamCode, advance(stage, ORDER[index + 1] ?? "final", generation));
    clock.advanceBy(1_000);
  }
};

/** DOの全テーブルを、行の中身ごと文字列にする（保存されていないことの確認用）。 */
export const dumpTeamRoom = (teamCode: string): Promise<string> =>
  runInDurableObject(env.TEAM_ROOM.getByName(teamCode), (_instance, state) => {
    const tables = state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
      .toArray()
      .map((row) => String(row.name));
    return JSON.stringify(
      tables.map((table) => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()),
    );
  });
