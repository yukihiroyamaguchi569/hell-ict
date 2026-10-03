import {
  stage1KarubeContext,
  stage1KarubeManual,
  stage1KarubeRound1Curt,
  stage1KarubeRound1Miss,
  stage1KarubeRound3Again,
  stage1KarubeRound3Hint,
} from "@hell-ict/content";
import type { Stage1State } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { stage1KarubeCalls } from "../../../src/stages/s1/karube-calls.js";

const T0 = 1_790_000_000_000;

const s1 = (patch: Partial<Stage1State>): Stage1State => ({
  stageStartedAt: T0,
  round: 1,
  roundStartedAt: T0,
  r3Try: 0,
  doneIds: [],
  curt: [],
  memoReplied: false,
  status: { phase: "playing" },
  ...patch,
});

const round3 = (r3Try: number, patch: Partial<Stage1State> = {}): Stage1State =>
  s1({ round: 3, r3Try, roundStartedAt: T0 + r3Try * 100_000, ...patch });

const ids = (calls: ReturnType<typeof stage1KarubeCalls>): string[] =>
  calls.map((call) => call.callId);

const id = (name: string): string => `s1:${String(T0)}:${name}`;

describe("stage1KarubeCalls: R1 と R2", () => {
  it("R1 の最中と R1 の結果窓では黙っている", () => {
    expect(stage1KarubeCalls(s1({}), null)).toEqual([]);
    expect(
      stage1KarubeCalls(s1({ status: { phase: "round-result", failure: "round1" } }), "curt"),
    ).toEqual([]);
  });

  it("R1 を手でクリアしたらオチの1行", () => {
    const state = s1({ status: { phase: "cleared", result: "manual" } });
    expect(stage1KarubeCalls(state, null)).toEqual([
      { callId: id("manual"), lines: [stage1KarubeManual] },
    ]);
  });

  it("R2 では R1 の原因で出し分け、記録が無ければ時間切れの台詞", () => {
    const round2 = s1({ round: 2, roundStartedAt: T0 + 90_000 });
    expect(stage1KarubeCalls(round2, "curt")).toEqual([
      { callId: id("round1"), lines: stage1KarubeRound1Curt },
    ]);
    expect(stage1KarubeCalls(round2, "missed")).toEqual([
      { callId: id("round1"), lines: stage1KarubeRound1Miss },
    ]);
    expect(stage1KarubeCalls(round2, null)).toEqual([
      { callId: id("round1"), lines: stage1KarubeRound1Miss },
    ]);
  });

  it("呼び出しの ID はステージの開始時刻を含む（リセット後はもう一度鳴る）", () => {
    const before = ids(stage1KarubeCalls(s1({ round: 2 }), null));
    const after = ids(stage1KarubeCalls(s1({ round: 2, stageStartedAt: T0 + 1 }), null));
    expect(before).not.toEqual(after);
  });
});

describe("stage1KarubeCalls: R3 のやり直しの声（r3Try の境目）", () => {
  it("r3Try=1 はコンテキスト指南", () => {
    expect(stage1KarubeCalls(round3(1), null)).toEqual([
      { callId: id("context"), lines: stage1KarubeContext },
    ]);
  });

  it.each([
    [2, 0],
    [3, 1],
    [4, 2],
  ])("r3Try=%i は Round3Again[%i]、挑戦ごとに別の ID", (r3Try, index) => {
    expect(stage1KarubeCalls(round3(r3Try), null)).toEqual([
      { callId: id(`again:${String(r3Try)}`), lines: stage1KarubeRound3Again[index] },
    ]);
  });

  it("r3Try=5 以降、返信前は黙っている（台詞が尽きた）", () => {
    expect(stage1KarubeCalls(round3(5), null)).toEqual([]);
    expect(stage1KarubeCalls(round3(9), null)).toEqual([]);
  });
});

describe("stage1KarubeCalls: #222 のヒント", () => {
  const replied = { doneIds: ["t1" as const] };
  const hint = (r3Try: number) => ({
    callId: id(`hint:${String(r3Try)}`),
    lines: stage1KarubeRound3Hint,
  });

  it("r3Try=1・2 は返信してもヒントを出さない", () => {
    expect(ids(stage1KarubeCalls(round3(1, replied), null))).toEqual([id("context")]);
    expect(ids(stage1KarubeCalls(round3(2, replied), null))).toEqual([id("again:2")]);
  });

  // 回帰（Luna 指摘）: r3Try 3〜4 はやり直しの声とヒントの両方が鳴ってよい（ユーザー決定5）。
  it.each([
    [3, 1],
    [4, 2],
  ])("r3Try=%i で1通返した後は、やり直しの声とヒントの両方（古い順）", (r3Try, index) => {
    expect(stage1KarubeCalls(round3(r3Try, replied), null)).toEqual([
      { callId: id(`again:${String(r3Try)}`), lines: stage1KarubeRound3Again[index] },
      hint(r3Try),
    ]);
  });

  it.each([5, 12])("r3Try=%i は1通返した後にヒントだけ", (r3Try) => {
    expect(stage1KarubeCalls(round3(r3Try, replied), null)).toEqual([hint(r3Try)]);
  });

  it("欄の中身は見ない: 引き継ぎメモへの返信だけではヒントにならない", () => {
    expect(ids(stage1KarubeCalls(round3(3, { memoReplied: true }), null))).toEqual([id("again:3")]);
  });

  it("前の挑戦の R1・R2 の返信は数えない", () => {
    expect(stage1KarubeCalls(round3(5, { doneIds: ["m1", "r1"] }), null)).toEqual([]);
  });

  // 回帰（Sol 指摘）: ヒントが出た後、開く前にラウンドが終わって再読み込みしても、結果窓で
  // その挑戦のヒントを復元する（既読なら鳴らさないのは use-karube 側）。
  it("1通返した挑戦の結果窓でも、その挑戦のヒントは一覧に残る", () => {
    const ended = (r3Try: number, patch: Partial<Stage1State> = replied) =>
      round3(r3Try, { ...patch, status: { phase: "round-result", failure: "round3" } });
    expect(stage1KarubeCalls(ended(5), null)).toEqual([hint(5)]);
    expect(ids(stage1KarubeCalls(ended(3), null))).toEqual([id("again:3"), id("hint:3")]);
    // 返信していない挑戦・r3Try<3 の挑戦には、結果窓でもヒントは無い。
    expect(stage1KarubeCalls(ended(5, {}), null)).toEqual([]);
    expect(ids(stage1KarubeCalls(ended(2), null))).toEqual([id("again:2")]);
  });
});
