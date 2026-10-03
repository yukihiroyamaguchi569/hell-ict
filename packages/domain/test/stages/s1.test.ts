import { describe, expect, it } from "vitest";

import { stageJudgementSchema } from "../../src/schemas/game.js";
import {
  acknowledgeStage1RoundResult,
  isCurtReply,
  judgeStage1,
  judgeStage1DraftRequest,
  sendStage1MemoReply,
  sendStage1Reply,
  settleStage1Round,
  shouldHintStage1Round3Retry,
  STAGE1_MAIL_IDS,
  STAGE1_MIN_REPLY_LENGTH,
  STAGE1_REPLY_LIMIT_MS,
  STAGE1_ROUND3_HINT_FROM_TRY,
  STAGE1_SCHEDULES,
  stage1AttemptNo,
  stage1FirstFailureCause,
  stage1Mails,
  stage1MemoDeadlineAt,
  stage1MemoStatus,
  stage1RoundSummary,
  stage1StateSchema,
  startStage1,
} from "../../src/stages/s1.js";
import type { Stage1MailId, Stage1State } from "../../src/stages/s1.js";
import { toStageJudgement } from "../../src/stages/stage-judgement.js";

const T0 = 1_790_000_000_000;
const at = (ms: number): number => T0 + ms;

/** Polite and 70+ characters: never curt. */
const GOOD =
  "3B病棟 各位\n" + "ご連絡ありがとうございます。".repeat(5) + "よろしくお願いいたします。";
const CURT = "承知しました。";

/** Sends one reply and expects it to be accepted. */
const reply = (
  state: Stage1State,
  mailId: Stage1MailId,
  text: string,
  now: number,
): Stage1State => {
  const result = sendStage1Reply(state, mailId, text, now);
  if (result.judgement.outcome !== "accepted") {
    throw new Error(`${mailId} refused: ${result.judgement.reason}`);
  }
  return result.state;
};

const replyAll = (state: Stage1State, text: string, now: number): Stage1State =>
  STAGE1_SCHEDULES[state.round].reduce((acc, mail) => reply(acc, mail.id, text, now), state);

const settle = (state: Stage1State, now: number) => settleStage1Round(state, now);

/** Lets the round run out with nothing answered, and returns the failed state. */
const failRound = (state: Stage1State): Stage1State => {
  const { state: ended, settlement } = settle(state, state.roundStartedAt + 85_001);
  if (settlement.type !== "round-failed") throw new Error("expected a failed round");
  return ended;
};

const next = (state: Stage1State, now: number): Stage1State => {
  const moved = acknowledgeStage1RoundResult(state, now);
  if (moved === null) throw new Error("no result window");
  return moved;
};

describe("Stage 1: 定数（モックの S1_* と同じ）", () => {
  it("締切60秒、70字（コンテキスト100字の条件は PR #266 で変更して廃止）", () => {
    expect(STAGE1_REPLY_LIMIT_MS).toBe(60_000);
    expect(STAGE1_MIN_REPLY_LENGTH).toBe(70);
  });

  it("3ラウンド×5通。着弾は 0/5/11/17/23 秒", () => {
    for (const round of [1, 2, 3] as const) {
      expect(STAGE1_SCHEDULES[round].map((mail) => mail.at)).toEqual([0, 5, 11, 17, 23]);
    }
    expect(STAGE1_SCHEDULES[1].map((mail) => mail.id)).toEqual(["m1", "m2", "m3", "m4", "m8"]);
    expect(STAGE1_SCHEDULES[2].map((mail) => mail.id)).toEqual(["r1", "r2", "r3", "r7", "r9"]);
    expect(STAGE1_SCHEDULES[3].map((mail) => mail.id)).toEqual(["t1", "t3", "t4", "t5", "t6"]);
  });

  it("メールIDの一覧はスケジュールと一致する", () => {
    expect([...STAGE1_MAIL_IDS]).toEqual(
      [1, 2, 3].flatMap((round) => STAGE1_SCHEDULES[round as 1 | 2 | 3].map((mail) => mail.id)),
    );
  });

  it("はじまり: R1、試行1回目、何も返していない", () => {
    const state = startStage1(T0);
    expect(state).toEqual({
      stageStartedAt: T0,
      round: 1,
      roundStartedAt: T0,
      r3Try: 0,
      doneIds: [],
      curt: [],
      memoReplied: false,
      status: { phase: "playing" },
    });
    expect(stage1AttemptNo(state)).toBe(1);
    expect(stage1StateSchema.safeParse(state).success).toBe(true);
  });
});

describe("Stage 1: 着弾と60秒の締切（Fake Clock）", () => {
  const state = startStage1(T0);

  it("各メールは at に着弾し、その60秒後が締切（画面の表示）", () => {
    const mails = stage1Mails(state, at(0));
    expect(mails.map((mail) => [mail.id, mail.landedAt - T0, mail.dueAt - T0])).toEqual([
      ["m1", 0, 60_000],
      ["m2", 5_000, 65_000],
      ["m3", 11_000, 71_000],
      ["m4", 17_000, 77_000],
      ["m8", 23_000, 83_000],
    ]);
  });

  it.each([
    [0, ["live", "pending", "pending", "pending", "pending"]],
    [4_999, ["live", "pending", "pending", "pending", "pending"]],
    [5_000, ["live", "live", "pending", "pending", "pending"]],
    [22_999, ["live", "live", "live", "live", "pending"]],
    [23_000, ["live", "live", "live", "live", "live"]],
  ])("開始 %ims の着弾", (elapsed, expected) => {
    expect(stage1Mails(state, at(elapsed)).map((mail) => mail.status)).toEqual(expected);
  });

  it.each([
    [59_999, "live"],
    [60_000, "live"],
    [60_001, "live"],
    [61_999, "live"],
    [62_000, "live"],
    [62_001, "missed"],
  ])(
    "1通目: 開始 %ims → %s（モックは t<=due まで開いている。猶予2秒込み）",
    (elapsed, expected) => {
      expect(stage1Mails(state, at(elapsed))[0]?.status).toBe(expected);
    },
  );

  it.each([
    [62_000, "accepted"],
    [62_001, "expired"],
  ])("1通目への返信: 開始 %ims → %s", (elapsed, expected) => {
    const result = sendStage1Reply(state, "m1", GOOD, at(elapsed));
    expect(result.judgement.outcome === "accepted" ? "accepted" : result.judgement.reason).toBe(
      expected,
    );
  });

  it("手つかずなら最後の1通は83秒の締切で失われ、ラウンドは85秒（猶予込み）で終わる", () => {
    expect(stage1Mails(state, at(85_000))[4]?.status).toBe("live");
    expect(settle(state, at(85_000)).settlement).toEqual({ type: "none" });
    expect(stage1Mails(state, at(85_001))[4]?.status).toBe("missed");
    expect(settle(state, at(85_001)).settlement).toEqual({
      type: "round-failed",
      failure: "round1",
    });
  });

  it("着弾前のメールには返信できない", () => {
    expect(sendStage1Reply(state, "m2", GOOD, at(4_999)).judgement).toEqual({
      outcome: "reject",
      reason: "not-landed",
    });
  });

  it("他のラウンドのメールには返信できない", () => {
    expect(sendStage1Reply(state, "r1", GOOD, at(1_000)).judgement).toEqual({
      outcome: "reject",
      reason: "not-in-round",
    });
  });
});

describe("Stage 1: 返信の判定（モックの s1Send）", () => {
  const state = startStage1(T0);

  it.each([
    ["69字で丁寧", "お願いします" + "あ".repeat(STAGE1_MIN_REPLY_LENGTH - 7), true],
    ["70字で丁寧", "お願いします" + "あ".repeat(STAGE1_MIN_REPLY_LENGTH - 6), false],
    ["70字でも丁寧句が無い", "あ".repeat(80), true],
    ["丁寧だが短い", "承知しました。よろしくお願いいたします。", true],
  ])("%s → curt=%s", (_name, text, curt) => {
    expect(isCurtReply(text)).toBe(curt);
  });

  it.each(["ます", "ください", "いたし", "ございま", "よろしく", "お願い", "存じ"])(
    "丁寧句「%s」",
    (phrase) => {
      expect(isCurtReply(phrase + "あ".repeat(80))).toBe(false);
    },
  );

  it("そっけない返信も送れる。本文（前後の空白を落とした形）を記録する", () => {
    const result = sendStage1Reply(state, "m1", `  ${CURT}  `, at(1_000));
    expect(result.judgement).toEqual({ outcome: "accepted", curt: true });
    expect(result.state.doneIds).toEqual(["m1"]);
    expect(result.state.curt).toEqual([{ mailId: "m1", reply: CURT }]);
  });

  it("前後の空白は長さに数えない", () => {
    const padded = " ".repeat(10) + "お願いします" + "あ".repeat(STAGE1_MIN_REPLY_LENGTH - 7);
    expect(sendStage1Reply(state, "m1", padded, at(1_000)).judgement).toEqual({
      outcome: "accepted",
      curt: true,
    });
  });

  it("丁寧で十分な返信は curt に入らない", () => {
    const result = sendStage1Reply(state, "m1", GOOD, at(1_000));
    expect(result.judgement).toEqual({ outcome: "accepted", curt: false });
    expect(result.state.curt).toEqual([]);
  });

  it.each(["", "   ", "\n\t", "　"])("空送信 %j は拒否し、状態を変えない", (text) => {
    const result = sendStage1Reply(state, "m1", text, at(1_000));
    expect(result.judgement).toEqual({ outcome: "reject", reason: "empty" });
    expect(result.state).toBe(state);
  });

  it("二度目の返信は already-sent", () => {
    const sent = reply(state, "m1", GOOD, at(1_000));
    const again = sendStage1Reply(sent, "m1", GOOD, at(2_000));
    expect(again.judgement).toEqual({ outcome: "reject", reason: "already-sent" });
    expect(again.state).toBe(sent);
  });

  it("ラウンドが終わった後は round-over", () => {
    const ended = failRound(state);
    expect(sendStage1Reply(ended, "m1", GOOD, at(85_002)).judgement).toEqual({
      outcome: "reject",
      reason: "round-over",
    });
  });
});

describe("Stage 1: ラウンドの終わり方（モックの s1RoundComplete）", () => {
  const state = startStage1(T0);

  it("全通が着弾する前は、返し終えても終わらない", () => {
    const partial = STAGE1_SCHEDULES[1]
      .slice(0, 4)
      .reduce((acc, mail) => reply(acc, mail.id, GOOD, at(20_000)), state);
    expect(settle(partial, at(22_999)).settlement).toEqual({ type: "none" });
  });

  it("R1 を丁寧に返し切れば手動クリア（manual）", () => {
    const done = replyAll(state, GOOD, at(23_000));
    const { state: cleared, settlement } = settle(done, at(23_000));
    expect(settlement).toEqual({ type: "cleared", result: "manual" });
    expect(cleared.status).toEqual({ phase: "cleared", result: "manual" });
    expect(judgeStage1(cleared)).toEqual({ outcome: "pass", result: "manual" });
  });

  it("全通返してもそっけない返信が1通あれば失敗", () => {
    const done = reply(
      STAGE1_SCHEDULES[1]
        .slice(1)
        .reduce((acc, mail) => reply(acc, mail.id, GOOD, at(23_000)), state),
      "m1",
      CURT,
      at(23_000),
    );
    expect(settle(done, at(23_000)).settlement).toEqual({
      type: "round-failed",
      failure: "round1",
    });
  });

  it("1通でも時間切れなら失敗", () => {
    const four = STAGE1_SCHEDULES[1]
      .slice(0, 4)
      .reduce((acc, mail) => reply(acc, mail.id, GOOD, at(23_000)), state);
    expect(settle(four, at(85_000)).settlement.type).toBe("none");
    expect(settle(four, at(85_001)).settlement).toEqual({
      type: "round-failed",
      failure: "round1",
    });
  });

  it("まだ開いているメールがあれば終わらない", () => {
    expect(settle(state, at(40_000)).settlement).toEqual({ type: "none" });
  });

  it("二度 settle しても二重に進まない", () => {
    const ended = failRound(state);
    const again = settle(ended, at(200_000));
    expect(again.settlement).toEqual({ type: "none" });
    expect(again.state).toBe(ended);
  });

  it("ラウンドが終わった後は、時間が進んでもメールの状態は変わらない", () => {
    const ended = failRound(state);
    expect(stage1Mails(ended, at(999_999)).map((mail) => mail.status)).toEqual(
      stage1Mails(ended, at(85_001)).map((mail) => mail.status),
    );
  });

  it("まだクリアしていなければ reject", () => {
    expect(judgeStage1(state)).toEqual({ outcome: "reject", reason: "not-cleared" });
    expect(judgeStage1(failRound(state))).toEqual({ outcome: "reject", reason: "not-cleared" });
  });

  it("罠は無い。toStageJudgement で状態機械の schema を満たす", () => {
    const cleared = settle(replyAll(state, GOOD, at(23_000)), at(23_000)).state;
    for (const sample of [state, cleared]) {
      const judgement = judgeStage1(sample);
      expect(judgement.outcome).not.toBe("trap");
      expect(stageJudgementSchema.safeParse(toStageJudgement(judgement)).success).toBe(true);
    }
  });
});

describe("Stage 1: 3ラウンドの流れと R3 のやり直し（Fake Clock のシナリオ）", () => {
  it("R1 失敗 → R2 失敗（手つかずは83秒で失われる）→ R3 → やり直しで doneIds が消える → クリア", () => {
    let state = startStage1(T0);
    // R1: 3 polite replies, then the rest expire.
    state = ["m1", "m2", "m3"].reduce(
      (acc, id) => reply(acc, id as Stage1MailId, GOOD, at(12_000)),
      state,
    );
    state = failRound(state);
    expect(stage1RoundSummary(state, at(85_001))).toEqual({
      total: 5,
      done: 3,
      missed: 2,
      curt: 0,
    });
    expect(stage1FirstFailureCause(state, at(85_001))).toBe("missed");

    // R2 starts when the button is pressed; its minute counts from then.
    const r2Start = at(100_000);
    state = next(state, r2Start);
    expect(state.round).toBe(2);
    expect(state.roundStartedAt).toBe(r2Start);
    expect(stage1AttemptNo(state)).toBe(2);
    expect(stage1Mails(state, r2Start).map((mail) => mail.status)).toEqual([
      "live",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    // Nothing answered: the last mail is lost at 83 s (+2 s grace).
    expect(settle(state, r2Start + 85_000).settlement.type).toBe("none");
    state = settle(state, r2Start + 85_001).state;
    expect(state.status).toMatchObject({ phase: "round-result", failure: "round2" });

    // R3: first try, two replies then time runs out.
    const r3Start = r2Start + 200_000;
    state = next(state, r3Start);
    expect([state.round, state.r3Try, stage1AttemptNo(state)]).toEqual([3, 1, 3]);
    state = reply(reply(state, "t1", GOOD, r3Start + 1_000), "t3", GOOD, r3Start + 6_000);
    expect(state.doneIds).toEqual(["m1", "m2", "m3", "t1", "t3"]);
    state = failRound(state);
    expect(state.status).toMatchObject({ phase: "round-result", failure: "round3" });

    // Retry: the R3 replies disappear (0 / 5), R1's stay, the clock starts again.
    const retryStart = r3Start + 300_000;
    state = next(state, retryStart);
    expect([state.round, state.r3Try, stage1AttemptNo(state)]).toEqual([3, 2, 4]);
    expect(state.doneIds).toEqual(["m1", "m2", "m3"]);
    expect(stage1RoundSummary(state, retryStart)).toEqual({
      total: 5,
      done: 0,
      missed: 0,
      curt: 0,
    });
    expect(stage1Mails(state, retryStart)[0]).toMatchObject({
      id: "t1",
      status: "live",
      dueAt: retryStart + 60_000,
    });
    // Without the reset, this attempt would already count as clean.
    expect(settle(state, retryStart + 23_000).settlement.type).toBe("none");

    // This attempt answers all five and clears with the AI.
    state = replyAll(state, GOOD, retryStart + 23_000);
    const { state: cleared, settlement } = settle(state, retryStart + 23_000);
    expect(settlement).toEqual({ type: "cleared", result: "ai" });
    expect(judgeStage1(cleared)).toEqual({ outcome: "pass", result: "ai" });
    expect(stage1StateSchema.safeParse(cleared).success).toBe(true);
  });

  it("遷移で作った状態は、どの段階でも保存から読み戻せる（schema の不変条件を満たす）", () => {
    const valid = (state: Stage1State) => stage1StateSchema.safeParse(state).success;
    let state = reply(startStage1(T0), "m1", CURT, at(1_000));
    expect(valid(state)).toBe(true);
    state = failRound(state);
    expect(valid(state)).toBe(true);
    state = next(state, at(100_000));
    expect(valid(state)).toBe(true);
    state = next(failRound(state), at(200_000));
    expect(valid(state)).toBe(true);
    state = next(failRound(reply(state, "t1", CURT, at(201_000))), at(300_000));
    expect(valid(state)).toBe(true);
    state = settle(replyAll(state, GOOD, at(323_000)), at(323_000)).state;
    expect(state.status).toEqual({ phase: "cleared", result: "ai" });
    expect(valid(state)).toBe(true);
    expect(valid(settle(replyAll(startStage1(T0), GOOD, at(23_000)), at(23_000)).state)).toBe(true);
  });

  it("R3 は何度でもやり直せる（上限なし）", () => {
    let state = next(failRound(next(failRound(startStage1(T0)), at(100_000))), at(200_000));
    for (let attempt = 0; attempt < 10; attempt++)
      state = next(failRound(state), state.roundStartedAt + 90_000);
    expect(state.r3Try).toBe(11);
    expect(stage1AttemptNo(state)).toBe(13);
  });

  it("R2 でそっけない返信を送ると、全通返しても R3 へ", () => {
    let state = next(failRound(startStage1(T0)), at(100_000));
    state = replyAll(state, CURT, at(123_000));
    expect(settle(state, at(123_000)).settlement).toEqual({
      type: "round-failed",
      failure: "round2",
    });
  });

  it("新しいラウンドでは curt を数え直す", () => {
    let state = reply(startStage1(T0), "m1", CURT, at(1_000));
    state = next(failRound(state), at(100_000));
    expect(state.curt).toEqual([]);
    expect(state.doneIds).toEqual(["m1"]);
  });

  it("R1 でそっけない返信が時間切れ以上なら、苅部さんはそっけない側から入る（同数もそっけない側）", () => {
    let state = startStage1(T0);
    state = ["m1", "m2", "m3"].reduce(
      (acc, id, i) => reply(acc, id as Stage1MailId, i < 2 ? CURT : GOOD, at(12_000)),
      state,
    );
    state = failRound(state);
    expect(stage1RoundSummary(state, at(85_001))).toMatchObject({ missed: 2, curt: 2 });
    expect(stage1FirstFailureCause(state, at(85_001))).toBe("curt");
  });

  it("結果の窓が無ければボタンは効かない", () => {
    const state = startStage1(T0);
    expect(acknowledgeStage1RoundResult(state, at(1_000))).toBeNull();
    const cleared = settle(replyAll(state, GOOD, at(23_000)), at(23_000)).state;
    expect(acknowledgeStage1RoundResult(cleared, at(30_000))).toBeNull();
  });
});

describe("Stage 1: 引き継ぎメモ（モックの s1MemoLive / s1SendMemo）", () => {
  const state = startStage1(T0);

  it("入場から60秒（猶予込み62秒）で一度だけ切れる", () => {
    expect(stage1MemoDeadlineAt(state)).toBe(at(60_000));
    expect(stage1MemoStatus(state, at(61_999))).toBe("live");
    expect(stage1MemoStatus(state, at(62_000))).toBe("missed");
  });

  it("ラウンドが変わっても蘇らない（起点は入場時刻のまま）", () => {
    const r2 = next(failRound(state), at(100_000));
    expect(stage1MemoStatus(r2, at(100_000))).toBe("missed");
  });

  it("結果の窓が開いていても、メモの時計は進む", () => {
    const quick = reply(state, "m1", CURT, at(1_000));
    const allCurt = STAGE1_SCHEDULES[1]
      .slice(1)
      .reduce((acc, mail) => reply(acc, mail.id, CURT, at(23_000)), quick);
    const ended = settle(allCurt, at(23_000)).state;
    expect(ended.status.phase).toBe("round-result");
    expect(stage1MemoStatus(ended, at(30_000))).toBe("live");
    expect(stage1MemoStatus(ended, at(62_000))).toBe("missed");
  });

  it("空だけ拒否し、中身は見ない。ラウンドには数えない", () => {
    expect(sendStage1MemoReply(state, "  ", at(1_000)).judgement).toEqual({
      outcome: "reject",
      reason: "empty",
    });
    const result = sendStage1MemoReply(state, "ありがとう", at(1_000));
    expect(result.judgement).toEqual({ outcome: "accepted", curt: false });
    expect(result.state).toEqual({ ...state, memoReplied: true });
    expect(stage1MemoStatus(result.state, at(999_999))).toBe("done");
  });

  it("返信済み・時間切れのメモには送れない", () => {
    const replied = sendStage1MemoReply(state, "はい", at(1_000)).state;
    expect(sendStage1MemoReply(replied, "はい", at(2_000)).judgement).toEqual({
      outcome: "reject",
      reason: "already-sent",
    });
    expect(sendStage1MemoReply(state, "はい", at(62_000)).judgement).toEqual({
      outcome: "reject",
      reason: "expired",
    });
  });

  it("ラウンドが終わった後（結果の窓・クリア後）はメモに送れない。状態も変えない", () => {
    const failed = settle(replyAll(state, CURT, at(23_000)), at(23_000)).state;
    const cleared = settle(replyAll(state, GOOD, at(23_000)), at(23_000)).state;
    for (const ended of [failed, cleared]) {
      expect(stage1MemoStatus(ended, at(30_000))).toBe("live");
      const result = sendStage1MemoReply(ended, "はい", at(30_000));
      expect(result.judgement).toEqual({ outcome: "reject", reason: "round-over" });
      expect(result.state).toBe(ended);
    }
  });

  it("メモに返信しても、5通をそっけなく返せば R1 は失敗のまま（クリア条件は5通から動かない）", () => {
    const withMemo = sendStage1MemoReply(state, "はい", at(1_000)).state;
    const five = replyAll(withMemo, GOOD, at(23_000));
    expect(settle(five, at(23_000)).settlement).toEqual({ type: "cleared", result: "manual" });
    const four = STAGE1_SCHEDULES[1]
      .slice(0, 4)
      .reduce((acc, mail) => reply(acc, mail.id, GOOD, at(23_000)), withMemo);
    expect(settle(four, at(85_001)).settlement.type).toBe("round-failed");
  });
});

describe("Stage 1: AI 下書きの条件（モックの s1Draft）", () => {
  const r1 = startStage1(T0);
  const R2_START = at(100_000);
  // Built inside each test: a throw here would drop the whole file instead of failing a test.
  const r2 = (): Stage1State => next(failRound(r1), R2_START);
  const context = "前任ICNの引き継ぎメモ";
  const material = { context, point: "x" };

  it.each([
    ["コンテキストだけ", { context, point: "" }, { outcome: "accepted", source: "context" }],
    [
      "コンテキスト1字でも下書きする（PR #266 で変更。モックは100字未満を数えなかった）",
      { context: "あ", point: "" },
      { outcome: "accepted", source: "context" },
    ],
    [
      "コンテキスト優先（要点もある。PR #266 で変更。モックは99字なら要点を使った）",
      { context: "あ", point: "申請先" },
      { outcome: "accepted", source: "context" },
    ],
    [
      "空白だけのコンテキスト＋要点は要点から",
      { context: " \n\t ", point: "申請先" },
      { outcome: "accepted", source: "point" },
    ],
    ["要点だけ", { context: "", point: "申請先" }, { outcome: "accepted", source: "point" }],
    [
      "空白だけのコンテキスト",
      { context: " \n ", point: "" },
      { outcome: "reject", reason: "no-material" },
    ],
    ["空白だけの要点", { context: "", point: "  " }, { outcome: "reject", reason: "no-material" }],
    ["どちらも無い", { context: "", point: "" }, { outcome: "reject", reason: "no-material" }],
  ])("%s", (_name, input, expected) => {
    expect(judgeStage1DraftRequest(r2(), "r1", input, R2_START)).toEqual(expected);
  });

  it("R1 にはボタンが無い", () => {
    expect(judgeStage1DraftRequest(r1, "m1", material, T0)).toEqual({
      outcome: "reject",
      reason: "no-ai",
    });
  });

  it.each([
    ["着弾前のメール", "r2", 4_999, "not-landed"],
    ["期限切れのメール（猶予込み）", "r1", 62_001, "expired"],
    ["別のラウンドのメール", "m1", 1_000, "not-in-round"],
  ] as const)("%s には下書きさせない", (_name, mailId, elapsed, reason) => {
    expect(judgeStage1DraftRequest(r2(), mailId, material, R2_START + elapsed)).toEqual({
      outcome: "reject",
      reason,
    });
  });

  it("期限ちょうど（猶予込み）までは下書きさせる", () => {
    expect(judgeStage1DraftRequest(r2(), "r1", material, R2_START + 62_000).outcome).toBe(
      "accepted",
    );
  });

  it("返信済みのメールには下書きさせない", () => {
    const sent = reply(r2(), "r1", GOOD, R2_START + 1_000);
    expect(judgeStage1DraftRequest(sent, "r1", material, R2_START + 2_000)).toEqual({
      outcome: "reject",
      reason: "already-sent",
    });
  });

  it("結果の窓が開いている間とクリア後は下書きさせない", () => {
    const failedR2 = failRound(r2());
    const clearedR2 = settle(replyAll(r2(), GOOD, at(123_000)), at(123_000)).state;
    for (const ended of [failedR2, clearedR2]) {
      expect(ended.status.phase).not.toBe("playing");
      expect(judgeStage1DraftRequest(ended, "r9", material, at(123_000))).toEqual({
        outcome: "reject",
        reason: "round-over",
      });
    }
  });
});

describe("stage1StateSchema（保存から読み戻す値）", () => {
  const base = startStage1(T0);

  it.each([
    ["重複した doneIds", { ...base, doneIds: ["m1", "m1"] }],
    ["知らないメール", { ...base, doneIds: ["x9"] }],
    ["R3 なのに r3Try が 0", { ...base, round: 3 }],
    ["R1 なのに r3Try が 1", { ...base, r3Try: 1 }],
    ["ラウンド4", { ...base, round: 4 }],
    ["知らない phase", { ...base, status: { phase: "done" } }],
    ["失敗の種類が無い結果", { ...base, status: { phase: "round-result" } }],
    ["余計な項目", { ...base, context: "memo" }],
    ["返していないのにクリア", { ...base, status: { phase: "cleared", result: "manual" } }],
    [
      "R1 のクリアなのに ai",
      {
        ...base,
        doneIds: ["m1", "m2", "m3", "m4", "m8"],
        status: { phase: "cleared", result: "ai" },
      },
    ],
    [
      "R2 のクリアなのに manual",
      {
        ...base,
        round: 2,
        doneIds: ["r1", "r2", "r3", "r7", "r9"],
        status: { phase: "cleared", result: "manual" },
      },
    ],
    [
      "そっけない返信が残ったままクリア",
      {
        ...base,
        doneIds: ["m1", "m2", "m3", "m4", "m8"],
        curt: [{ mailId: "m1", reply: "はい" }],
        status: { phase: "cleared", result: "manual" },
      },
    ],
    ["R1 なのに R3 の結果の窓", { ...base, status: { phase: "round-result", failure: "round3" } }],
    [
      "5通とも丁寧に返したのに失敗の窓（モックは clean ならクリアにする）",
      {
        ...base,
        doneIds: ["m1", "m2", "m3", "m4", "m8"],
        status: { phase: "round-result", failure: "round1" },
      },
    ],
    [
      "別のラウンドのそっけない返信",
      { ...base, doneIds: ["r1"], curt: [{ mailId: "r1", reply: "x" }] },
    ],
    ["返していないメールのそっけない返信", { ...base, curt: [{ mailId: "m1", reply: "x" }] }],
    ["まだ来ていないラウンドへの返信", { ...base, doneIds: ["r1", "r2", "r3", "r7", "r9"] }],
    ["R2 なのに R3 への返信", { ...base, round: 2, doneIds: ["t1"] }],
    ["ラウンドの開始がステージの開始より前", { ...base, roundStartedAt: T0 - 1 }],
  ])("%s は拒否する", (_name, value) => {
    expect(stage1StateSchema.safeParse(value).success).toBe(false);
  });

  it("R3 の途中の状態を通す", () => {
    expect(
      stage1StateSchema.safeParse({
        ...base,
        round: 3,
        r3Try: 2,
        doneIds: ["m1", "t1"],
        curt: [{ mailId: "t1", reply: "はい" }],
        status: { phase: "round-result", failure: "round3" },
      }).success,
    ).toBe(true);
  });
});

describe("Stage 1: R3 の3回目から苅部さんがヒントを出す（#222、モックからの改善）", () => {
  /** The R3 attempt `r3Try`, just started (R1 and R2 failed, then R3 failed `r3Try - 1` times). */
  const round3Try = (r3Try: number): Stage1State => {
    let state = next(failRound(next(failRound(startStage1(T0)), at(100_000))), at(200_000));
    while (state.r3Try < r3Try) state = next(failRound(state), state.roundStartedAt + 90_000);
    return state;
  };

  it("3回目から（画面の挑戦番号は5）", () => {
    expect(STAGE1_ROUND3_HINT_FROM_TRY).toBe(3);
    expect(stage1AttemptNo(round3Try(STAGE1_ROUND3_HINT_FROM_TRY))).toBe(5);
  });

  it.each([
    [1, false],
    [2, false],
    [3, true],
    [4, true],
    [11, true],
  ])("R3 の %i 回目 → %s", (r3Try, expected) => {
    const state = round3Try(r3Try);
    expect(state.r3Try).toBe(r3Try);
    expect(shouldHintStage1Round3Retry(state)).toBe(expected);
  });

  it("R3 の3回目で返信を送った後も、進行中なら出る（コンテキストは見ない）", () => {
    const started = round3Try(3);
    const state = reply(started, "t1", GOOD, started.roundStartedAt + 1_000);
    expect(state.status.phase).toBe("playing");
    expect(shouldHintStage1Round3Retry(state)).toBe(true);
  });

  it("R1・R2 では出ない（R3 以外）", () => {
    const r1 = startStage1(T0);
    const r2 = next(failRound(r1), at(100_000));
    expect(shouldHintStage1Round3Retry(r1)).toBe(false);
    expect(shouldHintStage1Round3Retry(r2)).toBe(false);
  });

  it("結果ウィンドウが開いている間とクリア後は出ない", () => {
    const failed = failRound(round3Try(3));
    expect(failed.status.phase).toBe("round-result");
    expect(shouldHintStage1Round3Retry(failed)).toBe(false);

    const state = round3Try(3);
    const allLanded = state.roundStartedAt + 23_000;
    const cleared = settle(replyAll(state, GOOD, allLanded), allLanded).state;
    expect(cleared.status).toEqual({ phase: "cleared", result: "ai" });
    expect(shouldHintStage1Round3Retry(cleared)).toBe(false);
  });

  it("ヒントは状態を変えず、60秒の締切も変えない", () => {
    const state = round3Try(4);
    const before = structuredClone(state);
    expect(shouldHintStage1Round3Retry(state)).toBe(true);
    expect(state).toEqual(before);
    expect(stage1Mails(state, state.roundStartedAt)[0]).toMatchObject({
      dueAt: state.roundStartedAt + STAGE1_REPLY_LIMIT_MS,
    });
  });
});
