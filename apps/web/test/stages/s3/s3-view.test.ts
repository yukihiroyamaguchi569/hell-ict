import { stage3KawaiMail, stage3ShichoMail } from "@hell-ict/content";
import { gameCommandResponseSchema } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { penaltyClockText } from "../../../src/stages/penalty/penalty-clock.js";
import {
  NOTICE_DELAY_MS,
  stage3InboxRows,
  stage3Overlay,
  stage3Result,
  stage3Verdict,
  type OverlayFacts,
} from "../../../src/stages/s3/s3-view.js";
import { applied, ENTERED_MS, s3State } from "./s3-fixtures.js";

describe("stage3Result / stage3Verdict", () => {
  it("pass はクリアの一行", () => {
    const result = stage3Result(applied({ outcome: "pass" }, ["stage-cleared"]));
    expect(result).toEqual({ kind: "pass" });
    expect(stage3Verdict(result)).toEqual({ kind: "cleared", text: "Stage 3 をクリアしました" });
  });

  it("reject は指した欄の名前で差し戻す", () => {
    const result = stage3Result(
      applied({ outcome: "reject", field: "release" }, ["submission-rejected"]),
    );
    expect(result).toEqual({ kind: "reject", field: "release" });
    expect(stage3Verdict(result)).toEqual({
      kind: "rejected",
      lines: ["接触予防策の解除基準の欄が、まだ足りません。"],
    });
  });

  it("罠の初回は trap-first（文言は出さない）、2回目以降は正典を促す文言だけ", () => {
    const first = stage3Result(applied({ outcome: "trap", field: "ppe" }, ["trap-triggered"]));
    expect(first).toEqual({ kind: "trap-first" });
    expect(stage3Verdict(first)).toBeNull();
    const again = stage3Result(
      applied({ outcome: "trap", field: "clean" }, ["trap-repeated"], s3State("done")),
    );
    expect(again).toEqual({ kind: "trap-repeated" });
    expect(stage3Verdict(again)).toEqual({
      kind: "rejected",
      lines: ["まだ基準が正しくありません。院内感染対策マニュアルを確認してください。"],
    });
  });

  it("送り直しの duplicate は最初の結果（original）で読む。罠の初回もそのまま初回", () => {
    const original = applied({ outcome: "trap", field: "ppe" }, ["trap-triggered"]);
    if (original.kind !== "done" || original.response.status !== "applied") throw new Error();
    const { events, judgement, ...rest } = original.response;
    const duplicate = gameCommandResponseSchema.parse({
      ...rest,
      status: "duplicate",
      original: { events, judgement },
    });
    expect(stage3Result({ kind: "done", response: duplicate })).toEqual({ kind: "trap-first" });
  });

  it("届かなかった・拒否された・読めない結果は何も言わない（もう一度押せる）", () => {
    for (const kind of ["unavailable", "failed", "stale", "not-ready", "superseded"] as const) {
      expect(stage3Result({ kind })).toEqual({ kind: "none" });
    }
    const refused = gameCommandResponseSchema.parse({
      status: "rejected",
      reason: "penalty-in-progress",
      judgement: null,
      state: s3State("in-progress"),
      pos: 3,
      serverNow: ENTERED_MS,
      ai: { status: "none" },
    });
    expect(stage3Result({ kind: "done", response: refused })).toEqual({ kind: "none" });
    expect(stage3Result(applied(null, []))).toEqual({ kind: "none" });
    expect(stage3Result(applied({ outcome: "reject" }, []))).toEqual({ kind: "none" });
    expect(stage3Result(applied({ outcome: "reject", field: "memo" }, []))).toEqual({
      kind: "none",
    });
    expect(stage3Verdict({ kind: "none" })).toBeNull();
  });
});

describe("stage3Overlay", () => {
  const facts = (over: Partial<OverlayFacts> = {}): OverlayFacts => ({
    state: s3State(),
    serverNow: ENTERED_MS + NOTICE_DELAY_MS,
    noticeSeen: false,
    trapScene: null,
    submitting: false,
    ...over,
  });

  it("一報は入場から赤帯のぶん（2600ms）待ってから。1ms 前はまだ出さない", () => {
    expect(stage3Overlay(facts({ serverNow: ENTERED_MS + NOTICE_DELAY_MS - 1 }))).toBeNull();
    expect(stage3Overlay(facts())).toBe("notice");
  });

  it("一報は閉じたら出さない。罠を踏んだ後のチームにも出さない", () => {
    expect(stage3Overlay(facts({ noticeSeen: true }))).toBeNull();
    expect(stage3Overlay(facts({ state: s3State("done") }))).toBeNull();
  });

  it("罰の間は、この端末の暗転・叱責が先で、それが無ければ（再読み込み後も）罰の窓", () => {
    const state = s3State("in-progress");
    expect(stage3Overlay(facts({ state, trapScene: "blackout" }))).toBe("blackout");
    expect(stage3Overlay(facts({ state, trapScene: "scold" }))).toBe("scold");
    expect(stage3Overlay(facts({ state, noticeSeen: true }))).toBe("penalty");
  });

  it("罰を払い終えたら、暗転や叱責が残っていても窓を出さない", () => {
    expect(stage3Overlay(facts({ state: s3State("done"), trapScene: "scold" }))).toBeNull();
  });

  it("提出の返事待ちの間と、Stage 3 以外では何も出さない", () => {
    expect(stage3Overlay(facts({ state: s3State("in-progress"), submitting: true }))).toBeNull();
    const moved = { ...s3State(), game: { ...s3State().game, stage: "s4" as const } };
    expect(stage3Overlay(facts({ state: moved }))).toBeNull();
  });
});

describe("stage3InboxRows", () => {
  it("師長・カワイさん・検査科の順で、どれも共通 viewer で開く", () => {
    expect(stage3InboxRows.map((row) => [row.id, row.opens, row.attach])).toEqual([
      ["s3shicho", { kind: "viewer", doc: "s3patients" }, stage3ShichoMail.attach],
      ["s3kawai", { kind: "viewer", doc: "s3contaminated" }, stage3KawaiMail.attach],
      ["s3lab", { kind: "viewer", doc: "s3lab" }, undefined],
    ]);
  });
});

describe("penaltyClockText", () => {
  it("払った時間を mm:ss で数え上げる。負の値は 00:00", () => {
    expect(penaltyClockText(-5)).toBe("00:00");
    expect(penaltyClockText(59_999)).toBe("00:59");
    expect(penaltyClockText(61_000)).toBe("01:01");
    expect(penaltyClockText(600_000)).toBe("10:00");
  });
});
