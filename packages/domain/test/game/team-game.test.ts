import { stage5IncidentReport } from "@hell-ict/content";
import { stage4Answers, stage5Answers, stage6Answers } from "@hell-ict/content/answers";
import { describe, expect, it } from "vitest";

import {
  applyTeamGameCommand,
  initialTeamGameState,
  teamGameLatestMs,
  teamGamePosition,
  teamGameStanding,
} from "../../src/game/team-game.js";
import type { TeamGameResult } from "../../src/game/team-game.js";
import type { GameStageId } from "../../src/schemas/game.js";
import { TEAM_GAME_REJECTION_REASONS, teamGameStateSchema } from "../../src/schemas/team-game.js";
import type { TeamGameCommand, TeamGameState } from "../../src/schemas/team-game.js";
import { INBOX_LIMIT_MS, INBOX_REPLY_REJECT_REASONS } from "../../src/stages/inbox.js";
import { STAGE1_REPLY_REJECT_REASONS } from "../../src/stages/s1.js";
import { STAGE2_DEADLINE_MS } from "../../src/stages/s2.js";
import { S6_MAIL_PARAGRAPHS } from "../../src/stages/s6.js";
import { redactPii, stage5Patient } from "../../src/pii.js";
import { GAME_REJECTION_REASONS } from "../../src/schemas/game.js";
import {
  at,
  command,
  GOOD_GRID,
  POLITE_REPLY,
  ROUND1,
  STAGE3_OK,
  STAGE3_TRAP,
  STAGE4_ACTION_OK,
  STAGE4_SUMMARY_OK,
  STAGE5_LIST_OK,
  STAGE6_PROMPT_OK,
} from "./team-game-fixtures.js";

const apply = (state: TeamGameState, cmd: TeamGameCommand, offsetMs = 0): TeamGameResult =>
  applyTeamGameCommand(state, cmd, at(offsetMs));

/** Applies and fails loudly unless applied; the new state must satisfy its own schema. */
const applied = (state: TeamGameState, cmd: TeamGameCommand, offsetMs = 0): TeamGameState => {
  const result = apply(state, cmd, offsetMs);
  if (result.status !== "applied") {
    throw new Error(`${cmd.type} was rejected: ${result.reason}`);
  }
  expect(teamGameStateSchema.safeParse(result.state).success).toBe(true);
  return result.state;
};

const expectRejected = (
  state: TeamGameState,
  cmd: TeamGameCommand,
  reason: string,
  offsetMs = 0,
): TeamGameResult => {
  const before = structuredClone(state);
  const result = apply(state, cmd, offsetMs);
  expect(result).toMatchObject({ status: "rejected", reason });
  expect(state).toEqual(before);
  return result;
};

const fresh = (): TeamGameState => initialTeamGameState(at(0).at);

const advance = (from: GameStageId, to: GameStageId): TeamGameCommand =>
  command("advance", { from, to });

/**
 * The regular route by correct submissions, with the clock moving on. Each step returns the
 * state and the time reached, so the next one continues from there.
 */
const STEPS: Record<
  Exclude<GameStageId, "final">,
  (state: TeamGameState, t: number) => { state: TeamGameState; t: number }
> = {
  prologue: (state, t) => {
    let next = applied(state, command("inbox.open"), t);
    for (const mailId of ["p0", "p1", "p2"]) {
      next = applied(next, command("inbox.reply", { mailId, text: "承知しました。" }), t + 1_000);
    }
    return { state: next, t: t + 2_000 };
  },
  s1: (state, t) => {
    let next = applied(state, command("s1.start"), t);
    // Every round-1 mail has landed 23 s after the start; all five get a polite reply.
    const replyAt = t + 24_000;
    for (const mail of ROUND1) {
      next = applied(next, command("s1.reply", { mailId: mail.id, text: POLITE_REPLY }), replyAt);
    }
    return { state: next, t: replyAt + 1_000 };
  },
  s2: (state, t) => {
    const started = applied(state, command("s2.start"), t);
    return {
      state: applied(started, command("s2.submit", { grid: GOOD_GRID }), t + 60_000),
      t: t + 61_000,
    };
  },
  s3: (state, t) => ({
    state: applied(state, command("s3.submit", { submission: STAGE3_OK }), t),
    t: t + 1_000,
  }),
  s4: (state, t) => {
    const summarized = applied(state, command("s4.submit-summary", { text: STAGE4_SUMMARY_OK }), t);
    return {
      state: applied(summarized, command("s4.submit-action", { text: STAGE4_ACTION_OK }), t),
      t: t + 1_000,
    };
  },
  s5: (state, t) => ({
    state: applied(state, command("s5.submit", { text: STAGE5_LIST_OK }), t),
    t: t + 1_000,
  }),
  s6: (state, t) => {
    const generated = applied(state, command("s6.generate", { prompt: STAGE6_PROMPT_OK }), t);
    return {
      state: applied(generated, command("s6.submit", { candidateIndex: 0 }), t),
      t: t + 1_000,
    };
  },
};

const ORDER: GameStageId[] = ["prologue", "s1", "s2", "s3", "s4", "s5", "s6", "final"];

/** A team that has just entered `target` by the regular route. */
const enteredStage = (target: GameStageId): { state: TeamGameState; t: number } => {
  let current = { state: fresh(), t: 0 };
  for (const [index, stage] of ORDER.entries()) {
    if (stage === target || stage === "final") break;
    const cleared = STEPS[stage](current.state, current.t);
    const to = ORDER[index + 1] ?? "final";
    current = { state: applied(cleared.state, advance(stage, to), cleared.t), t: cleared.t + 1 };
  }
  return current;
};

describe("初期状態", () => {
  it("Prologueから始まり、各ステージの状態はまだ無く、schemaを満たす", () => {
    const state = fresh();
    expect(state.game.stage).toBe("prologue");
    expect(state.startedAt).toBe(at(0).at);
    expect(state.enteredAt).toEqual({});
    expect([state.inbox, state.s1, state.s2]).toEqual([null, null, null]);
    expect(teamGameStateSchema.safeParse(state).success).toBe(true);
  });

  it("拒否理由の一覧はD1・受信トレイ・Stage 1の理由をすべて含む", () => {
    const all: readonly string[] = TEAM_GAME_REJECTION_REASONS;
    for (const reason of [
      ...GAME_REJECTION_REASONS,
      ...INBOX_REPLY_REJECT_REASONS,
      ...STAGE1_REPLY_REJECT_REASONS,
    ]) {
      expect(all).toContain(reason);
    }
  });
});

describe("正解の提出だけでPrologueからFinalまで通る", () => {
  it("各ステージのクリアがD1に記録され、Finalへ入った時刻がゴールになる", () => {
    const { state, t } = enteredStage("final");
    expect(state.game.stage).toBe("final");
    expect(Object.keys(state.game.clearedAt)).toEqual([
      "prologue",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
    ]);
    expect(state.game.penalties).toEqual({ s3: "none", s5: "none" });
    expect(state.enteredAt.final).toBe(at(t - 1).at);
    expect(teamGameStanding(state)).toEqual({
      stage: "final",
      pos: 7,
      reachedAt: state.game.clearedAt.s6,
      finishedAt: state.enteredAt.final,
    });
  });
});

describe("Prologue（受信トレイ）", () => {
  it("開く前の返信・締切処理は not-started", () => {
    expectRejected(fresh(), command("inbox.reply", { mailId: "p0", text: "はい" }), "not-started");
    expectRejected(fresh(), command("inbox.settle"), "not-started");
  });

  it("二度開いても時計は巻き戻らない（already-started）", () => {
    const opened = applied(fresh(), command("inbox.open"), 0);
    expectRejected(opened, command("inbox.open"), "already-started", 10_000);
  });

  it("空の返信は判定の詳細つきで拒否し、何も変えない", () => {
    const opened = applied(fresh(), command("inbox.open"), 0);
    const result = expectRejected(
      opened,
      command("inbox.reply", { mailId: "p0", text: "  " }),
      "empty",
    );
    expect(result.judgement).toEqual({ outcome: "reject", reason: "empty" });
  });

  it("3通を返すまではクリアせず、3通目でprologueのクリアをD1へ記録する", () => {
    let state = applied(fresh(), command("inbox.open"), 0);
    state = applied(state, command("inbox.reply", { mailId: "p0", text: "了解" }), 1_000);
    state = applied(state, command("inbox.reply", { mailId: "p1", text: "了解" }), 1_000);
    expect(state.game.clearedAt.prologue).toBeUndefined();
    const result = apply(state, command("inbox.reply", { mailId: "p2", text: "了解" }), 2_000);
    expect(result).toMatchObject({
      status: "applied",
      events: [{ type: "stage-cleared", stage: "prologue", at: at(2_000).at }],
      judgement: { outcome: "accepted" },
    });
  });

  it("締切の2秒猶予の間は開いたまま、猶予を過ぎたらinbox.settleでクリアする", () => {
    const opened = applied(fresh(), command("inbox.open"), 0);
    const lastMoment = INBOX_LIMIT_MS + 1_999;
    expectRejected(opened, command("inbox.settle"), "mails-open", lastMoment);
    const late = applied(
      opened,
      command("inbox.reply", { mailId: "p0", text: "間に合った" }),
      lastMoment,
    );
    expect(late.inbox?.sent).toEqual(["p0"]);
    expectRejected(
      opened,
      command("inbox.reply", { mailId: "p0", text: "遅い" }),
      "expired",
      INBOX_LIMIT_MS + 2_000,
    );
    const settled = apply(opened, command("inbox.settle"), INBOX_LIMIT_MS + 2_000);
    expect(settled).toMatchObject({ status: "applied", events: [{ type: "stage-cleared" }] });
  });

  it("Prologueを離れた後の受信トレイ操作は stage-mismatch", () => {
    const { state } = enteredStage("s1");
    expectRejected(state, command("inbox.open"), "stage-mismatch");
    expectRejected(state, command("inbox.reply", { mailId: "p0", text: "x" }), "stage-mismatch");
  });

  it("クリア済み（未前進）の受信トレイへの返信は already-cleared", () => {
    const cleared = STEPS.prologue(fresh(), 0).state;
    expectRejected(cleared, command("inbox.settle"), "already-cleared");
  });
});

describe("Stage 1", () => {
  const inStage1 = (): { state: TeamGameState; t: number } => enteredStage("s1");

  it("開始前の返信は not-started、開始の二度押しは already-started", () => {
    const { state, t } = inStage1();
    expectRejected(
      state,
      command("s1.reply", { mailId: "m1", text: POLITE_REPLY }),
      "not-started",
      t,
    );
    const started = applied(state, command("s1.start"), t);
    expectRejected(started, command("s1.start"), "already-started", t + 1);
  });

  it("着弾前のメールへの返信は not-landed", () => {
    const { state, t } = inStage1();
    const started = applied(state, command("s1.start"), t);
    expectRejected(
      started,
      command("s1.reply", { mailId: "m8", text: POLITE_REPLY }),
      "not-landed",
      t + 22_999,
    );
  });

  it("そっけない返信も受け付け、ラウンドの終わりまで持ち越す（判定の詳細にcurtが載る）", () => {
    const { state, t } = inStage1();
    const started = applied(state, command("s1.start"), t);
    const result = apply(started, command("s1.reply", { mailId: "m1", text: "了解" }), t + 1_000);
    expect(result).toMatchObject({
      status: "applied",
      judgement: { outcome: "accepted", curt: true, settlement: { type: "none" } },
    });
  });

  it("時間切れのラウンドはs1.settleで失敗に確定し、s1.next-roundでR2へ進む", () => {
    const { state, t } = inStage1();
    const started = applied(state, command("s1.start"), t);
    // The last mail lands at 23 s and is open for 60 s plus the 2 s grace.
    expectRejected(started, command("s1.settle"), "round-not-over", t + 85_000);
    expectRejected(started, command("s1.next-round"), "no-round-result", t + 85_000);
    const failed = apply(started, command("s1.settle"), t + 85_001);
    expect(failed).toMatchObject({
      status: "applied",
      events: [],
      judgement: { settlement: { type: "round-failed", failure: "round1" } },
    });
    if (failed.status !== "applied") throw new Error("unreachable");
    const round2 = applied(failed.state, command("s1.next-round"), t + 90_000);
    expect(round2.s1?.round).toBe(2);
    expect(round2.s1?.roundStartedAt).toBe(at(t + 90_000).ms);
  });

  it("R3は何度でもやり直せる", () => {
    const { state, t } = inStage1();
    let s = applied(state, command("s1.start"), t);
    let now = t;
    for (const round of [1, 2, 3, 3]) {
      expect(s.s1?.round).toBe(round);
      now += 86_000;
      s = applied(s, command("s1.settle"), now);
      s = applied(s, command("s1.next-round"), now);
    }
    expect(s.s1?.r3Try).toBe(3);
  });

  it("引き継ぎメモへの返信はラウンドに数えない", () => {
    const { state, t } = inStage1();
    const started = applied(state, command("s1.start"), t);
    const replied = applied(started, command("s1.memo-reply", { text: "了解しました" }), t + 1_000);
    expect(replied.s1?.memoReplied).toBe(true);
    expect(replied.s1?.doneIds).toEqual([]);
    expectRejected(
      replied,
      command("s1.memo-reply", { text: "もう一度" }),
      "already-sent",
      t + 2_000,
    );
  });

  it("5通を丁寧に返した時点でクリアをD1へ記録する", () => {
    const { state, t } = inStage1();
    const cleared = STEPS.s1(state, t).state;
    expect(cleared.s1?.status).toEqual({ phase: "cleared", result: "manual" });
    expect(cleared.game.clearedAt.s1).toBeDefined();
    expectRejected(cleared, command("s1.settle"), "already-cleared", t + 100_000);
  });
});

describe("Stage 2", () => {
  it("開始前の提出は not-started、開始の二度押しは already-started", () => {
    const { state, t } = enteredStage("s2");
    expectRejected(state, command("s2.submit", { grid: GOOD_GRID }), "not-started", t);
    expectRejected(state, command("s2.take-addendum"), "not-started", t);
    const started = applied(state, command("s2.start"), t);
    expectRejected(started, command("s2.start"), "already-started", t + 1);
  });

  it("追加分は締切前は not-landed、締切後に1回だけ取り込める", () => {
    const { state, t } = enteredStage("s2");
    const started = applied(state, command("s2.start"), t);
    expectRejected(started, command("s2.take-addendum"), "not-landed", t + STAGE2_DEADLINE_MS - 1);
    const taken = applied(started, command("s2.take-addendum"), t + STAGE2_DEADLINE_MS);
    expect(taken.s2?.addendumTakenAt).toBe(at(t + STAGE2_DEADLINE_MS).ms);
    expectRejected(taken, command("s2.take-addendum"), "already-taken", t + STAGE2_DEADLINE_MS + 1);
  });

  it("誤った表は差し戻し（状態は変わらずsubmission-rejected）、詳細にセルが載る", () => {
    const { state, t } = enteredStage("s2");
    const started = applied(state, command("s2.start"), t);
    const bad = GOOD_GRID.map((row, i) =>
      i === 0 ? [row[0], row[1], "8/1", row[3], row[4], row[5]] : row,
    );
    const result = apply(started, command("s2.submit", { grid: bad }), t + 1_000);
    expect(result).toMatchObject({
      status: "applied",
      events: [{ type: "submission-rejected", stage: "s2" }],
      judgement: { outcome: "reject", check: "collection-date", cells: [{ row: 0, column: 2 }] },
    });
  });

  it("締切の2秒猶予の間は20行でも30行でも通り、猶予後の20行は差し戻す", () => {
    const { state, t } = enteredStage("s2");
    const started = applied(state, command("s2.start"), t);
    const inGrace = apply(
      started,
      command("s2.submit", { grid: GOOD_GRID }),
      t + STAGE2_DEADLINE_MS + 1_999,
    );
    expect(inGrace).toMatchObject({ status: "applied", events: [{ type: "stage-cleared" }] });
    const late = apply(
      started,
      command("s2.submit", { grid: GOOD_GRID }),
      t + STAGE2_DEADLINE_MS + 2_000,
    );
    expect(late).toMatchObject({
      status: "applied",
      judgement: { check: "row-count", reason: "addendum-not-taken" },
    });
  });
});

describe("Stage 3 の罠と罰（Issue #92）", () => {
  const trapped = (): { state: TeamGameState; t: number } => {
    const { state, t } = enteredStage("s3");
    const result = apply(state, command("s3.submit", { submission: STAGE3_TRAP }), t);
    expect(result).toMatchObject({
      status: "applied",
      events: [{ type: "trap-triggered", stage: "s3" }],
      judgement: { outcome: "trap", field: "ppe" },
    });
    if (result.status !== "applied") throw new Error("unreachable");
    return { state: result.state, t };
  };

  it("罰の実施中は正解の提出も前進も拒否する", () => {
    const { state, t } = trapped();
    expectRejected(
      state,
      command("s3.submit", { submission: STAGE3_OK }),
      "penalty-in-progress",
      t,
    );
    expectRejected(state, advance("s3", "s4"), "penalty-in-progress", t);
  });

  it("罰を終えれば正解で通り、前進できる。罰は二度終えられない", () => {
    const { state, t } = trapped();
    const paid = applied(state, command("s3.finish-penalty"), t + 1_000);
    expectRejected(paid, command("s3.finish-penalty"), "no-penalty-in-progress", t + 2_000);
    const again = apply(paid, command("s3.submit", { submission: STAGE3_TRAP }), t + 2_000);
    expect(again).toMatchObject({ status: "applied", events: [{ type: "trap-repeated" }] });
    const cleared = applied(paid, command("s3.submit", { submission: STAGE3_OK }), t + 3_000);
    expect(applied(cleared, advance("s3", "s4"), t + 4_000).game.stage).toBe("s4");
  });

  it("罠の無いステージで罰を終える操作は no-penalty-in-progress", () => {
    const { state, t } = enteredStage("s3");
    expectRejected(state, command("s3.finish-penalty"), "no-penalty-in-progress", t);
  });
});

describe("Stage 4", () => {
  it("要約より先の行動提案は summary-first", () => {
    const { state, t } = enteredStage("s4");
    expectRejected(
      state,
      command("s4.submit-action", { text: STAGE4_ACTION_OK }),
      "summary-first",
      t,
    );
  });

  it("先行症状の無い要約は判定の詳細つきで拒否する", () => {
    const { state, t } = enteredStage("s4");
    const result = expectRejected(
      state,
      command("s4.submit-summary", { text: stage4Answers.summaryNg }),
      "no-ocular-symptom",
      t,
    );
    expect(result.judgement).toEqual({ outcome: "reject", reason: "no-ocular-symptom" });
  });

  it("患者に向けた行動提案は差し戻す", () => {
    const { state, t } = enteredStage("s4");
    const summarized = applied(state, command("s4.submit-summary", { text: STAGE4_SUMMARY_OK }), t);
    const result = apply(
      summarized,
      command("s4.submit-action", { text: stage4Answers.actionAimedAtPatients }),
      t,
    );
    expect(result).toMatchObject({
      status: "applied",
      events: [{ type: "submission-rejected", stage: "s4" }],
      judgement: { outcome: "reject", reason: "aimed-at-patients" },
    });
  });
});

describe("Stage 5 の罠（AIへの個人情報）と罰（黒塗り）", () => {
  const piiIndices = stage5IncidentReport.flatMap((segment, i) =>
    segment.pii === true ? [i] : [],
  );

  const trapped = (): { state: TeamGameState; t: number } => {
    const { state, t } = enteredStage("s5");
    const result = apply(
      state,
      command("s5.check-ai-message", { text: stage5Answers.piiSentence }),
      t,
    );
    expect(result).toMatchObject({
      status: "applied",
      events: [{ type: "trap-triggered", stage: "s5" }],
      judgement: { outcome: "trap", detected: "患者氏名" },
    });
    if (result.status !== "applied") throw new Error("unreachable");
    return { state: result.state, t };
  };

  it("個人情報の無い送信はゲートを通り、何も変えない", () => {
    const { state, t } = enteredStage("s5");
    const result = apply(state, command("s5.check-ai-message", { text: "表を整えて" }), t);
    expect(result).toEqual({ status: "applied", state, events: [], judgement: null });
  });

  it("罰の間は提出も前進も拒否し、黒塗りが不十分なら判定の詳細つきで拒否する", () => {
    const { state, t } = trapped();
    expectRejected(state, command("s5.submit", { text: STAGE5_LIST_OK }), "penalty-in-progress", t);
    expectRejected(state, advance("s5", "s6"), "penalty-in-progress", t);
    const result = expectRejected(
      state,
      command("s5.submit-report", { maskedIndices: [] }),
      "report-incomplete",
      t,
    );
    expect(result.judgement).toEqual({ outcome: "reject", missing: true, over: false });
  });

  it("正しい黒塗りで罰が終わり、正解の提出で通る。罰の無い黒塗りは拒否する", () => {
    const { state, t } = trapped();
    const paid = applied(state, command("s5.submit-report", { maskedIndices: piiIndices }), t);
    expect(paid.game.penalties.s5).toBe("done");
    expectRejected(
      paid,
      command("s5.submit-report", { maskedIndices: piiIndices }),
      "no-penalty-in-progress",
      t,
    );
    expect(
      applied(paid, command("s5.submit", { text: STAGE5_LIST_OK }), t).game.clearedAt.s5,
    ).toBeDefined();
  });

  it("Stage 5以外で個人情報を送っても罠にはならない（stage-mismatch）", () => {
    const { state, t } = enteredStage("s4");
    expectRejected(
      state,
      command("s5.check-ai-message", { text: stage5Answers.piiName }),
      "stage-mismatch",
      t,
    );
  });
});

describe("Stage 6", () => {
  it("空の指示・メールの丸写しは生成せず、ログにも積まない", () => {
    const { state, t } = enteredStage("s6");
    expectRejected(state, command("s6.generate", { prompt: "   " }), "empty", t);
    const copied = `${stage6Answers.promptByType.pictogram}。${S6_MAIL_PARAGRAPHS[0] ?? ""}`;
    expectRejected(state, command("s6.generate", { prompt: copied }), "copied-from-mail", t);
  });

  it("タグの無い指示は直前の候補の種類を継ぎ、判定は指示の累積で見る", () => {
    const { state, t } = enteredStage("s6");
    let s = applied(
      state,
      command("s6.generate", { prompt: stage6Answers.promptByType.pictogram }),
      t,
    );
    const second = apply(
      s,
      command("s6.generate", { prompt: stage6Answers.promptMissingHours }),
      t,
    );
    expect(second).toMatchObject({ judgement: { index: 1, type: "pictogram" } });
    if (second.status !== "applied") throw new Error("unreachable");
    s = second.state;
    const early = apply(s, command("s6.submit", { candidateIndex: 1 }), t);
    expect(early).toMatchObject({ judgement: { outcome: "reject", reason: "visiting-hours" } });
    s = applied(s, command("s6.generate", { prompt: stage6Answers.promptMissingMask }), t);
    expect(
      applied(s, command("s6.submit", { candidateIndex: 0 }), t).game.clearedAt.s6,
    ).toBeDefined();
  });

  it("存在しない候補の提出は no-candidate", () => {
    const { state, t } = enteredStage("s6");
    expectRejected(state, command("s6.submit", { candidateIndex: 0 }), "no-candidate", t);
  });
});

describe("前進", () => {
  it("未クリアのまま・飛ばし・後退の前進はD1の理由で拒否する", () => {
    const { state, t } = enteredStage("s3");
    expectRejected(state, advance("s3", "s4"), "not-cleared", t);
    expectRejected(state, advance("s3", "s5"), "skip-forbidden", t);
    expectRejected(state, advance("s3", "s2"), "not-forward", t);
    expectRejected(state, advance("s2", "s3"), "stage-mismatch", t);
  });

  it("前進した先の入場時刻を残す", () => {
    const { state, t } = enteredStage("s4");
    expect(state.enteredAt.s4).toBe(at(t - 1).at);
  });
});

describe("サーバに残す本文の個人情報", () => {
  it("S1のそっけない返信は、個人情報を伏せ字にしてから残す（判定は元の本文で行う）", () => {
    const { state, t } = enteredStage("s1");
    const started = applied(state, command("s1.start"), t);
    const text = `${stage5Patient.name}さんの件、了解`;
    const result = apply(started, command("s1.reply", { mailId: "m1", text }), t + 1_000);
    expect(result).toMatchObject({ status: "applied", judgement: { curt: true } });
    if (result.status !== "applied") throw new Error("unreachable");
    expect(result.state.s1?.curt).toEqual([{ mailId: "m1", reply: redactPii(text) }]);
    expect(JSON.stringify(result.state)).not.toContain(stage5Patient.name);
  });

  it("S6の指示のログは、個人情報を伏せ字にしてから残し、判定は変わらない", () => {
    const { state, t } = enteredStage("s6");
    const prompt = `${STAGE6_PROMPT_OK}。${stage5Patient.name}さんのご家族向け`;
    const generated = applied(state, command("s6.generate", { prompt }), t);
    expect(generated.s6.promptLog).toEqual([redactPii(prompt)]);
    expect(JSON.stringify(generated)).not.toContain(stage5Patient.name);
    const submitted = apply(generated, command("s6.submit", { candidateIndex: 0 }), t);
    expect(submitted).toMatchObject({ status: "applied", events: [{ type: "stage-cleared" }] });
  });
});

describe("teamGameLatestMs（記録済みの最後の時刻）", () => {
  it("始まったばかりなら開始時刻", () => {
    expect(teamGameLatestMs(fresh())).toBe(at(0).ms);
  });

  it("クリア・入場の時刻のうち最も遅いもの（ステージの時計の時刻は含めない）", () => {
    const cleared = STEPS.prologue(fresh(), 0).state;
    expect(teamGameLatestMs(cleared)).toBe(at(1_000).ms);
    const entered = applied(cleared, advance("prologue", "s1"), 50_000);
    expect(teamGameLatestMs(entered)).toBe(at(50_000).ms);
    const started = applied(entered, command("s1.start"), 90_000);
    expect(teamGameLatestMs(started)).toBe(at(50_000).ms);
  });
});

describe("停留所（pos）と順位の基準", () => {
  it("ステージの位置、クリア済みなら+1", () => {
    expect(teamGamePosition(fresh())).toBe(0);
    const prologueCleared = STEPS.prologue(fresh(), 0).state;
    expect(teamGamePosition(prologueCleared)).toBe(1);
    const { state } = enteredStage("s1");
    expect(teamGamePosition(state)).toBe(1);
  });

  it("到達時刻は最後の操作ではなく、その停留所へ動いたクリアの時刻（#159）", () => {
    const cleared = STEPS.prologue(fresh(), 0).state;
    const clearedAt = cleared.game.clearedAt.prologue;
    const entered = applied(cleared, advance("prologue", "s1"), 50_000);
    expect(teamGameStanding(cleared)).toEqual({
      stage: "prologue",
      pos: 1,
      reachedAt: clearedAt,
      finishedAt: null,
    });
    expect(teamGameStanding(entered)).toEqual({
      stage: "s1",
      pos: 1,
      reachedAt: clearedAt,
      finishedAt: null,
    });
  });

  it("Prologueで何もしていなければ到達時刻はゲームの開始", () => {
    expect(teamGameStanding(fresh()).reachedAt).toBe(at(0).at);
  });
});

describe("状態のschema", () => {
  it("現在地より先の入場時刻・現在地の入場時刻の欠落・候補とログの数の食い違いを拒否する", () => {
    const { state } = enteredStage("s2");
    expect(
      teamGameStateSchema.safeParse({
        ...state,
        enteredAt: { ...state.enteredAt, s3: state.startedAt },
      }).success,
    ).toBe(false);
    expect(
      teamGameStateSchema.safeParse({ ...state, enteredAt: { s1: state.startedAt } }).success,
    ).toBe(false);
    expect(
      teamGameStateSchema.safeParse({ ...state, s6: { promptLog: ["x"], candidates: [] } }).success,
    ).toBe(false);
    expect(teamGameStateSchema.safeParse(state).success).toBe(true);
  });
});
