import { env } from "cloudflare:workers";
import {
  gameInstantSchema,
  judgeS5Report,
  PII_REDACTION,
  S6_MAIL_PARAGRAPHS,
} from "@hell-ict/domain";
import type { TeamGameCommand } from "@hell-ict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { activitySchemaSql } from "../src/activity-log.js";
import { gameActivityRows } from "../src/game-activity.js";
import { ACTIVITY_OUTBOX_CHUNK } from "../src/game-store.js";
import {
  advance,
  applied,
  CLEAR,
  command,
  playTo,
  send,
  STAGE3_OK,
  STAGE3_TRAP,
  STAGE5_LIST,
} from "./game-command-support.js";
import { stage4Answers } from "@hell-ict/content/answers";
import { clock, countRows, gameOf, gmReset } from "./game-support.js";
import { session } from "./support.js";
import { SECOND_NAME_JOINED, SECOND_PATIENT, SECOND_SURNAME } from "./pii-support.js";

/**
 * ゲームのコマンドを適用したときの、サーバ側の活動ログ（Issue #235・#216）。DOとD1は本物を
 * 使い、D1のactivity_eventsに積まれた行を読んで確かめる。
 */

beforeEach(() => {
  clock.reset();
});

const rowSchema = z.object({
  kind: z.string(),
  view: z.string(),
  command_id: z.string(),
  text: z.string(),
  meta: z.string(),
  client_at: z.string(),
});

const activityOf = async (teamCode: string) => {
  const result = await env.PROGRESS_DB.prepare(
    "SELECT kind, view, command_id, text, meta, client_at FROM activity_events WHERE team_code = ? ORDER BY id",
  )
    .bind(teamCode)
    .all();
  return z
    .array(rowSchema)
    .parse(result.results)
    .map((row) => ({
      ...row,
      meta: z.record(z.string(), z.unknown()).parse(JSON.parse(row.meta)),
    }));
};

const kindsOf = async (teamCode: string): Promise<string[]> =>
  (await activityOf(teamCode)).map((row) => row.kind);

describe("提出・判定・クリア・前進を記録する", () => {
  it("Prologueを正解で抜けると、提出・判定・クリア・前進の行がサーバの印つきで積まれる", async () => {
    const teamCode = "950001";
    await playTo(teamCode, "s1");
    const rows = await activityOf(teamCode);
    // inbox.openは判定が無いので行を出さない。
    expect(rows.map((row) => row.kind)).toEqual([
      "game.submit",
      "game.verdict",
      "game.submit",
      "game.verdict",
      "game.submit",
      "game.verdict",
      "game.clear",
      "game.enter",
    ]);
    expect(rows.every((row) => row.meta.source === "server")).toBe(true);
    expect(rows[0]).toMatchObject({
      view: "inbox",
      text: "承知しました。",
      meta: { command: "inbox.reply", stage: "prologue", mailId: "p0" },
    });
    expect(rows[1]?.meta).toMatchObject({ outcome: "accepted" });
    // クリアはPrologueの画面、前進は入ったステージの画面で残す。
    expect(rows.at(-2)).toMatchObject({ view: "inbox", meta: { stage: "prologue" } });
    expect(rows.at(-1)).toMatchObject({ view: "s1", meta: { command: "advance", stage: "s1" } });
    const view = await gameOf(teamCode);
    expect(rows.at(-2)?.client_at).toBe(view.state.game.clearedAt.prologue);
    expect(rows.at(-1)?.client_at).toBe(view.state.enteredAt.s1);
    await expect(countRows(teamCode, "game_activity_outbox")).resolves.toBe(0);
  });

  it("自己申告のkind（submit.*・verdict.*・trap.*）は1行も書かない（既存の集計と混ざらない）", async () => {
    const teamCode = "950002";
    await playTo(teamCode, "final");
    const kinds = new Set(await kindsOf(teamCode));
    expect([...kinds].sort()).toEqual(["game.clear", "game.enter", "game.submit", "game.verdict"]);
  });

  it("適用された差し戻し（S4の対象ずれ）は判定の行に理由の識別子を残す", async () => {
    const teamCode = "950003";
    await playTo(teamCode, "s4");
    await applied(teamCode, command("s4.submit-summary", { text: stage4Answers.summaryOk }));
    await applied(
      teamCode,
      command("s4.submit-action", { text: stage4Answers.actionAimedAtPatients }),
    );
    const rows = await activityOf(teamCode);
    expect(rows.at(-1)).toMatchObject({
      kind: "game.verdict",
      view: "s4",
      meta: { source: "server", command: "s4.submit-action", outcome: "reject" },
    });
    expect(rows.at(-1)?.meta.reason).toEqual(expect.any(String));
    expect(rows.at(-2)).toMatchObject({ kind: "game.submit", meta: { which: "action" } });
  });

  it("入れ子の判定（S2の差し戻しのセル）はJSON文字列でmetaに入る", async () => {
    const teamCode = "950004";
    await playTo(teamCode, "s2");
    await applied(teamCode, command("s2.start"));
    clock.advanceBy(120_000);
    const bad = [["", "5A", "2026-08-01", "陰性", "なし", ""]];
    await applied(teamCode, command("s2.submit", { grid: bad }));
    const verdict = (await activityOf(teamCode)).at(-1);
    expect(verdict).toMatchObject({ kind: "game.verdict", meta: { outcome: "reject" } });
    expect(typeof verdict?.meta.cells).toBe("string");
    expect(JSON.parse(String(verdict?.meta.cells))).toEqual(expect.any(Array));
  });
});

describe("拒否された提出（差し戻し）", () => {
  it("S6の丸写しは生成せずに差し戻され、その差し戻しが記録に残る（#216）", async () => {
    const teamCode = "950101";
    await playTo(teamCode, "s6");
    const copied = `ピクトグラムで。${S6_MAIL_PARAGRAPHS[0] ?? ""}`;
    expect(await send(teamCode, command("s6.generate", { prompt: copied }))).toMatchObject({
      status: "rejected",
      reason: "copied-from-mail",
    });
    const rows = await activityOf(teamCode);
    // 拒否された提出は1行にまとめ、本文もこの行に入れる。
    expect(rows.at(-1)).toMatchObject({
      kind: "game.rejected",
      view: "s6",
      text: copied,
      meta: { source: "server", command: "s6.generate", stage: "s6", reason: "copied-from-mail" },
    });
    expect(rows.at(-2)?.kind).toBe("game.enter");
  });

  it("判定の詳細つきの拒否（S4の要約）は、判定の識別子と拒否の理由を残す", async () => {
    const teamCode = "950102";
    await playTo(teamCode, "s4");
    await send(teamCode, command("s4.submit-summary", { text: "発熱が続いている。" }));
    expect((await activityOf(teamCode)).at(-1)).toMatchObject({
      kind: "game.rejected",
      meta: { outcome: "reject", reason: "no-ocular-symptom" },
    });
  });

  it("提出でないコマンドの拒否は、判定が付いたとき（早すぎる締め）だけ記録する", async () => {
    const teamCode = "950103";
    await applied(teamCode, command("inbox.open"));
    expect((await send(teamCode, command("inbox.settle"))).status).toBe("rejected");
    expect((await send(teamCode, advance("prologue", "s1"))).status).toBe("rejected");
    expect((await send(teamCode, command("s1.start"))).status).toBe("rejected");
    const rows = await activityOf(teamCode);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "game.rejected",
      view: "inbox",
      text: "",
      meta: { command: "inbox.settle", outcome: "reject", reason: "mails-open" },
    });
  });
});

describe("罠と罰（#216: 罰にかかった時間）", () => {
  it("S3: 罠の発動は罠と罰の開始、繰り返しは罠だけ、罰の完了はかかった時間を残す", async () => {
    const teamCode = "950201";
    await playTo(teamCode, "s3");
    await applied(teamCode, command("s3.submit", { submission: STAGE3_TRAP }));
    clock.advanceBy(30_000);
    // 罰の最中の提出は拒否されるが、提出の差し戻しとして残る。
    await send(teamCode, command("s3.submit", { submission: STAGE3_TRAP }));
    clock.advanceBy(95_000);
    await applied(teamCode, command("s3.finish-penalty"));
    await applied(teamCode, command("s3.submit", { submission: STAGE3_OK }));
    const rows = await activityOf(teamCode);
    const fromTrap = rows.slice(rows.findIndex((row) => row.kind === "game.trap") - 2);
    expect(fromTrap.map((row) => row.kind)).toEqual([
      "game.submit",
      "game.verdict",
      "game.trap",
      "penalty.start",
      "game.rejected",
      "penalty.complete",
      "game.submit",
      "game.verdict",
      "game.clear",
    ]);
    expect(fromTrap[2]?.meta).toMatchObject({ stage: "s3", repeated: false });
    expect(fromTrap[4]).toMatchObject({
      text: JSON.stringify(STAGE3_TRAP),
      meta: { reason: "penalty-in-progress" },
    });
    const complete = fromTrap[5];
    expect(complete?.meta).toMatchObject({
      command: "s3.finish-penalty",
      stage: "s3",
      startedAt: fromTrap[3]?.client_at,
      durationMs: 125_000,
    });
  });

  it("罠の繰り返し（罰の後にもう一度罠）は repeated: true で残り、罰は始まらない", async () => {
    const teamCode = "950202";
    await playTo(teamCode, "s3");
    await applied(teamCode, command("s3.submit", { submission: STAGE3_TRAP }));
    await applied(teamCode, command("s3.finish-penalty"));
    await applied(teamCode, command("s3.submit", { submission: STAGE3_TRAP }));
    const rows = await activityOf(teamCode);
    expect(rows.filter((row) => row.kind === "penalty.start")).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ kind: "game.trap", meta: { repeated: true } });
  });

  it("S5: 罠の本文も提出本文も残さず、個人情報も残さない。報告の完了で罰の時間を残す", async () => {
    const teamCode = "950203";
    await playTo(teamCode, "s5");
    await applied(
      teamCode,
      command("s5.check-ai-message", {
        text: `${SECOND_PATIENT.id}\t${SECOND_NAME_JOINED}\t${SECOND_PATIENT.ward}`,
      }),
    );
    clock.advanceBy(200_000);
    // 伏せ字の足りない報告は差し戻し、足りた報告で罰が終わる。
    await send(teamCode, command("s5.submit-report", { maskedIndices: [] }));
    // 伏せてよい箇所（個人情報の箇所と、判定が見ない箇所）だけを伏せる。
    const maskable = Array.from({ length: 1_000 }, (_, i) => i).filter((i) => {
      const alone = judgeS5Report([i]);
      return alone.outcome === "pass" || !alone.over;
    });
    await applied(teamCode, command("s5.submit-report", { maskedIndices: maskable }));
    const rows = await activityOf(teamCode);
    expect(JSON.stringify(rows)).not.toContain(SECOND_SURNAME);
    // Stage 5へ入った行（game.enter）の後から。
    const s5 = rows.filter((row) => row.meta.stage === "s5").slice(1);
    expect(s5.find((row) => row.kind === "game.verdict")?.meta).toMatchObject({
      command: "s5.check-ai-message",
      outcome: "trap",
      detected: "患者氏名",
    });
    expect(s5.slice(1, 3).map((row) => row.kind)).toEqual(["game.trap", "penalty.start"]);
    expect(rows.slice(-3).map((row) => row.kind)).toEqual([
      "game.submit",
      "game.verdict",
      "penalty.complete",
    ]);
    expect(rows.at(-1)?.meta).toMatchObject({ stage: "s5", durationMs: 200_000 });
    expect(rows.find((row) => row.kind === "game.rejected")).toMatchObject({
      text: "",
      meta: { form: "report", masked: 0, reason: "report-incomplete", missing: true },
    });
    expect(s5.every((row) => row.text === "")).toBe(true);

    await send(
      teamCode,
      command("s5.submit", { text: `${STAGE5_LIST}\n備考\t${SECOND_NAME_JOINED}` }),
    );
    const linelist = (await activityOf(teamCode)).filter(
      (row) => row.kind === "game.submit" && row.meta.form === "linelist",
    );
    expect(linelist.every((row) => row.text === "" && typeof row.meta.chars === "number")).toBe(
      true,
    );
  });
});

describe("個人情報", () => {
  it("本文の個人情報は伏せ字にして残す（本文ごと捨てない）", async () => {
    const teamCode = "950301";
    await playTo(teamCode, "s4");
    await send(
      teamCode,
      command("s4.submit-summary", {
        text: `${SECOND_NAME_JOINED}さんに発熱の前に別の症状が先行した。`,
      }),
    );
    const submit = (await activityOf(teamCode)).find(
      (row) => row.meta.command === "s4.submit-summary",
    );
    expect(submit?.text).toContain(PII_REDACTION);
    expect(submit?.text).toContain("発熱の前に別の症状が先行した");
    expect(submit?.text).not.toContain(SECOND_SURNAME);
    expect(submit?.meta.piiRedacted).toBeUndefined();
  });
});

describe("冪等と記録の失敗", () => {
  it("同じcommandIdの再送（duplicate）は行を増やさない", async () => {
    const teamCode = "950401";
    await applied(teamCode, command("inbox.open"));
    const body = command("inbox.reply", { mailId: "p0", text: "了解" });
    await applied(teamCode, body);
    const before = await activityOf(teamCode);
    expect((await send(teamCode, body)).status).toBe("duplicate");
    expect(await activityOf(teamCode)).toEqual(before);
    await expect(countRows(teamCode, "game_activity_outbox")).resolves.toBe(0);
  });

  it("拒否された提出を同じcommandIdで送り直しても、行は増えない", async () => {
    const teamCode = "950402";
    await playTo(teamCode, "s4");
    const body = command("s4.submit-summary", { text: "発熱が続いている。" });
    await send(teamCode, body);
    await send(teamCode, body);
    const rows = await activityOf(teamCode);
    expect(rows.filter((row) => row.command_id === body.commandId).map((row) => row.kind)).toEqual([
      "game.rejected",
    ]);
  });

  it("拒否された提出が同じcommandIdで後から通ると、拒否と提出・判定がどちらも残る", async () => {
    const teamCode = "950406";
    const body = command("inbox.reply", { mailId: "p0", text: "承知しました。" });
    expect(await send(teamCode, body)).toMatchObject({ status: "rejected", reason: "not-started" });
    await applied(teamCode, command("inbox.open"));
    await applied(teamCode, body);
    const rows = await activityOf(teamCode);
    expect(rows.map((row) => [row.kind, row.command_id, row.text])).toEqual([
      ["game.rejected", body.commandId, "承知しました。"],
      ["game.submit", body.commandId, "承知しました。"],
      ["game.verdict", body.commandId, ""],
    ]);
  });

  it("D1が落ちていてもコマンドは通り、行はDOに残って、D1が戻った後のGETで1回だけ積まれる", async () => {
    const teamCode = "950403";
    await CLEAR.prologue?.(teamCode);
    const before = await activityOf(teamCode);
    expect(before.length).toBeGreaterThan(0);
    await env.PROGRESS_DB.exec("DROP TABLE activity_events");
    try {
      const reply = await applied(teamCode, advance("prologue", "s1"));
      expect(reply.state.game.stage).toBe("s1");
      await expect(countRows(teamCode, "game_activity_outbox")).resolves.toBe(1);
    } finally {
      await env.PROGRESS_DB.exec(activitySchemaSql);
    }
    await gameOf(teamCode);
    await gameOf(teamCode);
    await expect(countRows(teamCode, "game_activity_outbox")).resolves.toBe(0);
    expect(await kindsOf(teamCode)).toEqual(["game.enter"]);
  });

  it("D1が長く落ちて送信待ちが区切りを超えて溜まっても、戻った後に全部積まれる", async () => {
    const teamCode = "950407";
    await applied(teamCode, command("inbox.open"));
    await env.PROGRESS_DB.exec("DROP TABLE activity_events");
    const settles = Array.from({ length: ACTIVITY_OUTBOX_CHUNK * 2 + 5 }, () =>
      command("inbox.settle"),
    );
    try {
      for (const body of settles) {
        expect((await send(teamCode, body)).status).toBe("rejected");
      }
      await expect(countRows(teamCode, "game_activity_outbox")).resolves.toBe(settles.length);
    } finally {
      await env.PROGRESS_DB.exec(activitySchemaSql);
    }
    await gameOf(teamCode);
    await expect(countRows(teamCode, "game_activity_outbox")).resolves.toBe(0);
    const rows = await activityOf(teamCode);
    expect(rows.map((row) => row.command_id)).toEqual(settles.map((body) => body.commandId));
  });

  it("送り直しで同じ行が2度届いても、D1には1行しか残らない", async () => {
    const teamCode = "950404";
    await CLEAR.prologue?.(teamCode);
    const rows = await activityOf(teamCode);
    const { recordGameActivity } = await import("../src/activity-log.js");
    const resent = rows.map((row) => ({
      kind: row.kind,
      commandId: row.command_id,
      view: row.view,
      text: row.text,
      meta: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .parse(row.meta),
      at: row.client_at,
    }));
    await recordGameActivity(env, teamCode, resent);
    expect(await activityOf(teamCode)).toEqual(rows);
  });

  it("GMリセットで送信待ちの行も消え、リセット後の世代の行だけが積まれる", async () => {
    const teamCode = "950405";
    await session(teamCode);
    await CLEAR.prologue?.(teamCode);
    expect((await gmReset(teamCode)).status).toBe(200);
    await expect(countRows(teamCode, "game_activity_outbox")).resolves.toBe(0);
    await applied(teamCode, command("inbox.open", {}, 1));
    await applied(teamCode, command("inbox.reply", { mailId: "p0", text: "a" }, 1));
    expect((await kindsOf(teamCode)).filter((kind) => kind === "gm.reset")).toHaveLength(1);
  });
});

describe("gameActivityRows（変換だけ）", () => {
  const at = gameInstantSchema.parse("2026-10-31T01:00:00.000Z");
  const finish = {
    type: "s3.finish-penalty",
    commandId: "11111111-1111-4111-8111-111111111111",
    generation: 0,
  } satisfies TeamGameCommand;

  it("罰の始まりが分からなければ、かかった時間はnullで残す（行は落とさない）", () => {
    const rows = gameActivityRows({
      command: finish,
      outcome: {
        status: "applied",
        events: [{ type: "penalty-completed", stage: "s3", at }],
        judgement: null,
      },
      at,
      penaltyStarts: {},
    });
    expect(rows).toEqual([
      {
        kind: "penalty.complete",
        commandId: finish.commandId,
        view: "s3",
        text: "",
        meta: {
          source: "server",
          command: "s3.finish-penalty",
          stage: "s3",
          startedAt: null,
          durationMs: null,
        },
        at,
      },
    ]);
  });

  it("判定の無い適用（開封・開始）と、差し戻しの状態機械のeventは行を出さない", () => {
    expect(
      gameActivityRows({
        command: { ...finish, type: "s1.start" },
        outcome: { status: "applied", events: [], judgement: null },
        at,
        penaltyStarts: {},
      }),
    ).toEqual([]);
    const rows = gameActivityRows({
      command: { ...finish, type: "s3.submit", submission: STAGE3_OK },
      outcome: {
        status: "applied",
        events: [{ type: "submission-rejected", stage: "s3", at }],
        judgement: { outcome: "reject", field: "ppe" },
      },
      at,
      penaltyStarts: {},
    });
    expect(rows.map((row) => row.kind)).toEqual(["game.submit", "game.verdict"]);
    expect(rows[1]?.meta).toEqual({
      source: "server",
      command: "s3.submit",
      stage: "s3",
      outcome: "reject",
      field: "ppe",
    });
  });
});
