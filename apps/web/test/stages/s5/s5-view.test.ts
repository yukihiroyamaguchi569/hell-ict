import {
  stage5Labels,
  stage5ReportVerdicts as R,
  stage5SendFailed,
  stage5SubmissionRejectLines,
} from "@hell-ict/content";
import { STAGE5_DEADLINE_MS } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  reportResult,
  STAGE5_ROWS,
  stage5CallWanted,
  stage5MissionDeadline,
  stage5Overlay,
  stage5Result,
  submitVerdict,
  type Stage5OverlayFacts,
} from "../../../src/stages/s5/s5-view.js";
import { answer, ENTERED, ENTERED_MS, s5State } from "./s5-fixtures.js";

describe("stage5Result（保健所への提出）", () => {
  it("通れば passed。送り直しの duplicate は最初の判定を読む", () => {
    expect(stage5Result(answer({ judgement: { outcome: "pass" } }))).toEqual({ kind: "passed" });
    const original = { events: [], judgement: { outcome: "pass" } };
    expect(stage5Result(answer({ status: "duplicate", original }))).toEqual({ kind: "passed" });
  });

  it("差し戻しは理由をすべて content の文で並べる（#221）", () => {
    const reasons = [{ reason: "ids", missingIds: ["008", "030"] }, { reason: "date" }] as const;
    expect(stage5Result(answer({ judgement: { outcome: "reject", reasons } }))).toEqual({
      kind: "sent-back",
      lines: stage5SubmissionRejectLines(reasons),
    });
  });

  it.each([
    [{ kind: "unavailable" } as const, "retry"],
    [{ kind: "failed" } as const, "retry"],
    [{ kind: "stale" } as const, "none"],
    [{ kind: "superseded" } as const, "none"],
    [answer({ status: "rejected", reason: "stage-mismatch" }), "none"],
    [answer({ judgement: { outcome: "reject", reasons: [] } }), "none"],
    [answer({ judgement: { outcome: "trap" } }), "none"],
  ])("%o は %s", (outcome, kind) => {
    expect(stage5Result(outcome).kind).toBe(kind);
  });
});

describe("reportResult（黒塗りの報告書）", () => {
  const incomplete = (judgement: unknown, reason = "report-incomplete") =>
    answer({ status: "rejected", reason, judgement });

  it.each([
    [true, false, [R.missing]],
    [false, true, [R.over]],
    [true, true, [R.missing, R.over]],
  ])("塗り残し %s・塗りすぎ %s は両方言う", (missing, over, lines) => {
    expect(reportResult(incomplete({ outcome: "reject", missing, over }))).toEqual({
      kind: "sent-back",
      lines,
    });
  });

  it("通れば passed。払い済みの拒否や読めない判定は none、届かなければ retry", () => {
    expect(reportResult(answer({ judgement: { outcome: "pass" } }))).toEqual({ kind: "passed" });
    expect(reportResult(incomplete(null, "no-penalty-in-progress")).kind).toBe("none");
    const both = { outcome: "reject", missing: true, over: true };
    expect(reportResult(incomplete(both, "stage-mismatch")).kind).toBe("none");
    const neither = { outcome: "reject", missing: false, over: false };
    expect(reportResult(incomplete(neither)).kind).toBe("none");
    expect(reportResult({ kind: "failed" }).kind).toBe("retry");
  });

  it("送り直しの duplicate は最初の判定で読む: 差し戻しなら差し戻し、通っていれば passed、読めなければ none", () => {
    const dup = (judgement: unknown) =>
      reportResult(answer({ status: "duplicate", original: { events: [], judgement } }));
    expect(dup({ outcome: "reject", missing: true, over: false })).toEqual({
      kind: "sent-back",
      lines: [R.missing],
    });
    expect(dup({ outcome: "pass" })).toEqual({ kind: "passed" });
    expect(dup(null).kind).toBe("none");
  });
});

it("submitVerdict: 判定中が先、通れば渡した文、届かなければ送り直しの文、ほかは箱なし", () => {
  expect(submitVerdict(true, { kind: "passed" }, "通過")).toEqual({ kind: "checking" });
  expect(submitVerdict(false, { kind: "passed" }, "通過")).toEqual({
    kind: "cleared",
    text: "通過",
  });
  expect(submitVerdict(false, { kind: "sent-back", lines: ["a"] }, "")).toEqual({
    kind: "rejected",
    lines: ["a"],
  });
  expect(submitVerdict(false, { kind: "retry" }, "")).toEqual({
    kind: "rejected",
    lines: [stage5SendFailed],
  });
  expect(submitVerdict(false, { kind: "none" }, "")).toBeNull();
  expect(submitVerdict(false, null, "")).toBeNull();
});

describe("stage5Overlay（窓の出し分け）", () => {
  const running = s5State("in-progress");
  const done = s5State("done");
  const s6 = { ...running, game: { ...running.game, stage: "s6" as const } };
  const facts = (over: Partial<Stage5OverlayFacts>): Stage5OverlayFacts => ({
    state: s5State(),
    trapScene: null,
    penaltyHeld: false,
    callWanted: false,
    submitting: false,
    ...over,
  });

  it.each([
    ["罠の警報", { state: running, trapScene: "alarm" }, "alarm"],
    ["罠の叱責", { state: running, trapScene: "scold" }, "scold"],
    ["罰が走っていなければ罠の場面は出さない", { trapScene: "scold" }, null],
    ["罰の窓", { state: running }, "penalty"],
    ["督促は罰の後に回す（決定7）", { state: running, callWanted: true }, "penalty"],
    ["罰の後の督促", { state: done, callWanted: true }, "call"],
    ["提出の返事待ちは督促を待たせる", { callWanted: true, submitting: true }, null],
    ["送信しましたの間は罰の窓のまま", { state: done, penaltyHeld: true }, "penalty"],
    ["ステージを離れたら何も出さない", { state: s6, callWanted: true }, null],
  ] as const)("%s", (_, over, expected) => {
    expect(stage5Overlay(facts(over))).toBe(expected);
  });
});

it.each([
  [ENTERED, null, false, true],
  [null, null, false, false],
  [ENTERED, ENTERED, false, false],
  [ENTERED, null, true, false],
  ["2026-10-31T00:00:00.000Z", null, false, false],
])("stage5CallWanted: 鳴った %s・閉じた %s・クリア %s → %s", (rang, seen, cleared, wanted) => {
  expect(stage5CallWanted(s5State("none", { cleared }), rang, seen)).toBe(wanted);
});

it("受信トレイは事務長のメール1通で、押すと発熱患者一覧をビューアで開く", () => {
  expect(STAGE5_ROWS.map((row) => [row.id, row.opens])).toEqual([
    ["s5jimu", { kind: "viewer", doc: "s5list" }],
  ]);
});

describe("stage5MissionDeadline（ミッションバーの提出期限）", () => {
  it("S5 への入場から2分後を、見出しと超過の文言つきで返す（起点は enteredAt.s5）", () => {
    expect(stage5MissionDeadline(s5State())).toEqual({
      at: ENTERED_MS + STAGE5_DEADLINE_MS,
      label: stage5Labels.deadline,
      overText: stage5Labels.deadlineOver,
    });
  });

  it("罰の最中も期限は動き続ける（罰は時間で払う）", () => {
    expect(stage5MissionDeadline(s5State("in-progress"))?.at).toBe(ENTERED_MS + STAGE5_DEADLINE_MS);
  });

  it("クリアしたら出さない（モックはクリアで止める）", () => {
    expect(stage5MissionDeadline(s5State("none", { cleared: true }))).toBeNull();
  });

  it("S5 に入っていない状態や、別のステージでは出さない", () => {
    const state = s5State();
    const { s1, s2, s3, s4 } = state.enteredAt;
    expect(stage5MissionDeadline({ ...state, enteredAt: { s1, s2, s3, s4 } })).toBeNull();
    expect(stage5MissionDeadline({ ...state, game: { ...state.game, stage: "s6" } })).toBeNull();
  });
});
