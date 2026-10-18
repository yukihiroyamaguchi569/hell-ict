import {
  stage1MailsRound2,
  stage1MailsRound3,
  stage1MemoText,
  stage1Rules,
} from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import {
  acknowledgeStage1RoundResult,
  isCurtReply,
  isPastedMemoReply,
  sendStage1MemoReply,
  sendStage1Reply,
  settleStage1Round,
  STAGE1_SCHEDULES,
  stage1FirstFailureCause,
  stage1MemoOverlap,
  stage1RoundSummary,
  stage1StateSchema,
  startStage1,
} from "../../src/stages/s1.js";
import type { Stage1MailId, Stage1State } from "../../src/stages/s1.js";

/*
 * Issue #44: pasting the handover memo into a reply let a team clear a round without the AI
 * (event 00, team 000001 cleared R1 in 19 s on 2026-10-18). Such a reply is `pasted`, a failure
 * of its own beside `curt`.
 */

const T0 = 1_790_000_000_000;
const MIN_RUN = stage1Rules.pastedMemo.minRun;

/** Polite, long enough and shares nothing long with the memo. */
const GOOD =
  "3B病棟 各位\n" + "ご連絡ありがとうございます。".repeat(5) + "よろしくお願いいたします。";

/**
 * A polite frame long enough on its own, so only the memo part can fail the reply. The quote is
 * set in 『』, which the memo never uses, so the frame cannot lengthen the shared run.
 */
const framed = (quote: string): string =>
  "ご連絡ありがとうございます。前任からの引き継ぎによると、次のとおりです。『" +
  quote +
  "』ご不明な点があれば、お気軽にお問い合わせください。よろしくお願いいたします。";

/** The memo's longest paragraph, cut to `length` characters from its start. */
const memoSlice = (length: number): string => {
  const longest = stage1MemoText.split("\n").reduce((a, b) => (b.length > a.length ? b : a), "");
  return longest.slice(0, length);
};

const reply = (
  state: Stage1State,
  mailId: Stage1MailId,
  text: string,
  now: number,
): Stage1State => {
  const result = sendStage1Reply(state, mailId, text, now);
  if (result.judgement.outcome !== "accepted") throw new Error(`${mailId} refused`);
  return result.state;
};

/** Every mail of the round answered with `GOOD`, except `first`, which gets `text`. */
const roundWith = (state: Stage1State, text: string): Stage1State => {
  const now = state.roundStartedAt + 23_000;
  return STAGE1_SCHEDULES[state.round].reduce(
    (acc, mail, i) => reply(acc, mail.id, i === 0 ? text : GOOD, now),
    state,
  );
};

const settleNow = (state: Stage1State) => settleStage1Round(state, state.roundStartedAt + 23_000);

/** Fails the round by the clock and acknowledges the window (R1 → R2, R2 → R3, R3 → R3). */
const nextRound = (state: Stage1State): Stage1State => {
  const ended = settleStage1Round(state, state.roundStartedAt + 85_001).state;
  const moved = acknowledgeStage1RoundResult(ended, ended.roundStartedAt + 90_000);
  if (moved === null) throw new Error("no result window");
  return moved;
};

const inRound = (round: 1 | 2 | 3): Stage1State => {
  let state = startStage1(T0);
  while (state.round !== round) state = nextRound(state);
  return state;
};

describe("Stage 1: 引き継ぎメモの貼り付け（pasted）の判定", () => {
  it("値は content の rules から読む（40字、比べる相手は引き継ぎメモの本文）", () => {
    expect(MIN_RUN).toBe(40);
    expect(stage1Rules.pastedMemo.text).toBe(stage1MemoText);
  });

  it("メモの全文を貼った返信は pasted（長く丁寧なので curt には当たらない）", () => {
    expect(isCurtReply(stage1MemoText)).toBe(false);
    expect(isPastedMemoReply(stage1MemoText)).toBe(true);
    expect(stage1MemoOverlap(stage1MemoText)).toBe(stage1MemoText.length);
  });

  it(`メモの一部 ${String(MIN_RUN)} 字をそのまま含めば pasted、${String(MIN_RUN - 1)} 字なら通る（境界値）`, () => {
    const atLimit = framed(memoSlice(MIN_RUN));
    const belowLimit = framed(memoSlice(MIN_RUN - 1));
    expect(stage1MemoOverlap(atLimit)).toBe(MIN_RUN);
    expect(isPastedMemoReply(atLimit)).toBe(true);
    expect(stage1MemoOverlap(belowLimit)).toBe(MIN_RUN - 1);
    expect(isPastedMemoReply(belowLimit)).toBe(false);
    expect(isCurtReply(belowLimit)).toBe(false);
  });

  it("メモと一字も重ならない返信・空文字は 0", () => {
    expect(stage1MemoOverlap("")).toBe(0);
    expect(stage1MemoOverlap("ｘｙｚ")).toBe(0);
    expect(isPastedMemoReply("")).toBe(false);
  });

  it("メモの別々の箇所を短く引くだけなら、合計が40字を超えても通る（続いた部分だけを見る）", () => {
    const lines = stage1MemoText.split("\n").slice(1, 4);
    const quotes = lines.map((line) => line.slice(2, 2 + MIN_RUN - 10)).join("。また、");
    expect(quotes.length).toBeGreaterThan(MIN_RUN * 2);
    expect(isPastedMemoReply(framed(quotes))).toBe(false);
  });
});

describe("Stage 1: pasted の返信の扱い", () => {
  it("受け付けて送るが、curt ではなく pasted に記録する（全文）", () => {
    const state = startStage1(T0);
    const result = sendStage1Reply(state, "m1", `  ${stage1MemoText}\n`, T0 + 1_000);
    expect(result.judgement).toEqual({ outcome: "accepted", curt: false, pasted: true });
    expect(result.state.doneIds).toEqual(["m1"]);
    expect(result.state.curt).toEqual([]);
    expect(result.state.pasted).toEqual([{ mailId: "m1", reply: stage1MemoText }]);
  });

  it("curt と pasted の両方に当たる返信（短い・丁寧語なしのメモの切れ端）は pasted だけに入る", () => {
    const text = memoSlice(MIN_RUN);
    expect(isCurtReply(text)).toBe(true);
    const result = sendStage1Reply(startStage1(T0), "m1", text, T0 + 1_000);
    expect(result.judgement).toEqual({ outcome: "accepted", curt: false, pasted: true });
    expect(result.state.curt).toEqual([]);
    expect(result.state.pasted).toHaveLength(1);
  });

  it("そっけないだけの返信は従来どおり curt（pasted は false）", () => {
    const result = sendStage1Reply(startStage1(T0), "m1", "了解です", T0 + 1_000);
    expect(result.judgement).toEqual({ outcome: "accepted", curt: true, pasted: false });
    expect(result.state.pasted).toEqual([]);
  });

  it("拒否される返信（空・着弾前）は pasted にも記録しない", () => {
    const state = startStage1(T0);
    expect(sendStage1Reply(state, "m8", stage1MemoText, T0).state).toBe(state);
    expect(sendStage1Reply(state, "m1", "   ", T0).state).toBe(state);
  });

  it("メモ（id memo）への返信は判定しない。メモを貼っても pasted にならず、ラウンドにも数えない", () => {
    const result = sendStage1MemoReply(startStage1(T0), stage1MemoText, T0 + 1_000);
    expect(result.judgement).toEqual({ outcome: "accepted", curt: false, pasted: false });
    expect(result.state.pasted).toEqual([]);
    expect(result.state.doneIds).toEqual([]);
  });
});

describe("Stage 1: pasted があるラウンドはクリアしない", () => {
  it.each([1, 2, 3] as const)("R%i: 全通返しても1通 pasted なら失敗（禁止された遷移）", (round) => {
    const { state, settlement } = settleNow(roundWith(inRound(round), stage1MemoText));
    expect(settlement).toEqual({ type: "round-failed", failure: `round${String(round)}` });
    expect(state.status.phase).toBe("round-result");
    expect(stage1StateSchema.safeParse(state).success).toBe(true);
  });

  it.each([1, 2, 3] as const)("R%i: 39字の引用なら同じ返し方でクリアする", (round) => {
    const { settlement } = settleNow(roundWith(inRound(round), framed(memoSlice(MIN_RUN - 1))));
    expect(settlement).toEqual({ type: "cleared", result: round === 1 ? "manual" : "ai" });
  });

  it("R1 を5通ともメモの貼り付けで返しても manual クリアにならない（10/18 の抜け道）", () => {
    const state = startStage1(T0);
    const pastedAll = STAGE1_SCHEDULES[1].reduce(
      (acc, mail) => reply(acc, mail.id, stage1MemoText, T0 + 23_000),
      state,
    );
    const { state: ended, settlement } = settleStage1Round(pastedAll, T0 + 23_000);
    expect(settlement).toEqual({ type: "round-failed", failure: "round1" });
    expect(stage1RoundSummary(ended, T0 + 23_000)).toEqual({
      total: 5,
      done: 5,
      missed: 0,
      curt: 0,
      pasted: 5,
    });
  });

  it("新しいラウンドと R3 のやり直しでは pasted を数え直す", () => {
    const failedR1 = settleNow(roundWith(startStage1(T0), stage1MemoText)).state;
    const r2 = acknowledgeStage1RoundResult(failedR1, T0 + 30_000);
    expect(r2?.pasted).toEqual([]);
    const failedR3 = settleNow(roundWith(inRound(3), stage1MemoText)).state;
    const retry = acknowledgeStage1RoundResult(failedR3, failedR3.roundStartedAt + 30_000);
    expect(retry?.pasted).toEqual([]);
    expect(retry?.r3Try).toBe(2);
  });
});

describe("Stage 1: R1 が pasted だけで落ちたときの原因（苅部さんの R1 の台詞）", () => {
  const ended = (replies: Partial<Record<Stage1MailId, string>>): Stage1State => {
    const sent = STAGE1_SCHEDULES[1].reduce((acc, { id }) => {
      const text = replies[id];
      return text === undefined ? acc : reply(acc, id, text, T0 + 23_000);
    }, startStage1(T0));
    return settleStage1Round(sent, T0 + 85_001).state;
  };
  const allFive = (text: string, patch: Partial<Record<Stage1MailId, string>> = {}) => ({
    m1: text,
    m2: GOOD,
    m3: GOOD,
    m4: GOOD,
    m8: GOOD,
    ...patch,
  });

  it("pasted だけ（そっけない返信も時間切れも無い）なら pasted", () => {
    expect(stage1FirstFailureCause(ended(allFive(stage1MemoText)), T0 + 85_001)).toBe("pasted");
  });

  it("pasted とそっけない返信が混ざれば従来どおり curt", () => {
    const state = ended(allFive(stage1MemoText, { m2: "了解" }));
    expect(stage1FirstFailureCause(state, T0 + 85_001)).toBe("curt");
  });

  it("pasted と時間切れが混ざれば従来どおり missed", () => {
    expect(stage1FirstFailureCause(ended({ m1: stage1MemoText }), T0 + 85_001)).toBe("missed");
  });
});

describe("Stage 1: 正解ルートの下書きは pasted に当たらない", () => {
  const drafts = [...stage1MailsRound2, ...stage1MailsRound3].flatMap((mail) => [
    { id: mail.id, kind: "draftCtx", text: mail.draftCtx.join("\n") },
    { id: mail.id, kind: "draftPlain", text: mail.draftPlain.join("\n") },
  ]);

  it.each(drafts)("$id の $kind", ({ text }) => {
    expect(stage1MemoOverlap(text)).toBeLessThan(MIN_RUN);
    expect(isPastedMemoReply(text)).toBe(false);
  });
});

describe("stage1StateSchema と pasted", () => {
  const base = startStage1(T0);

  it("pasted を持たない保存済みの状態は、空の pasted として読む", () => {
    const saved = Object.fromEntries(Object.entries(base).filter(([key]) => key !== "pasted"));
    expect(saved).not.toHaveProperty("pasted");
    const parsed = stage1StateSchema.safeParse(saved);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.pasted).toEqual([]);
  });

  it.each<[string, Stage1State]>([
    ["返していないメールの pasted", { ...base, pasted: [{ mailId: "m1", reply: "x" }] }],
    [
      "このラウンドでないメールの pasted",
      { ...base, doneIds: ["m1"], pasted: [{ mailId: "r1", reply: "x" }] },
    ],
    [
      "pasted があるのにクリア",
      {
        ...base,
        doneIds: ["m1", "m2", "m3", "m4", "m8"],
        pasted: [{ mailId: "m1", reply: "x" }],
        status: { phase: "cleared", result: "manual" },
      },
    ],
  ])("%s は読み戻さない", (_label, state) => {
    expect(stage1StateSchema.safeParse(state).success).toBe(false);
  });

  it("pasted だけで失敗したラウンドの結果は読み戻せる", () => {
    const state: Stage1State = {
      ...base,
      doneIds: ["m1", "m2", "m3", "m4", "m8"],
      pasted: [{ mailId: "m1", reply: "x" }],
      status: { phase: "round-result", failure: "round1" },
    };
    expect(stage1StateSchema.safeParse(state).success).toBe(true);
  });
});
