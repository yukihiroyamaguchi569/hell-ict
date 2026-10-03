import { stage4ActionRejects, stage4SummaryReject } from "@hell-ict/content";
import { gameCommandResponseSchema } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import type { SendOutcome } from "../../../src/composables/use-game-session.js";
import { submitResult } from "../../../src/stages/common/submit-result.js";
import { actionSentBackLine, summarySentBackLine } from "../../../src/stages/s4/s4-view.js";
import { viewBody } from "../../fakes.js";

const done = (response: Record<string, unknown>): SendOutcome => ({
  kind: "done",
  response: gameCommandResponseSchema.parse({ ...viewBody(5), ...response }),
});

describe("submitResult", () => {
  it("送り直しで返った duplicate は、最初の判定の差し戻しをもう一度言う", () => {
    const outcome = done({
      status: "duplicate",
      original: { events: [], judgement: { outcome: "reject", reason: "missing-whom" } },
    });
    expect(submitResult(outcome, actionSentBackLine)).toEqual({
      kind: "sent-back",
      line: stage4ActionRejects["missing-whom"],
    });
  });

  it("要約の差し戻しは rejected で返る", () => {
    const outcome = done({
      status: "rejected",
      reason: "no-ocular-symptom",
      judgement: { outcome: "reject", reason: "no-ocular-symptom" },
    });
    expect(submitResult(outcome, summarySentBackLine)).toEqual({
      kind: "sent-back",
      line: stage4SummaryReject,
    });
  });

  it("ほかの理由の拒否（ステージが進んでいた等）は何も言わない", () => {
    const outcome = done({ status: "rejected", reason: "stage-mismatch", judgement: null });
    expect(submitResult(outcome, summarySentBackLine)).toEqual({ kind: "none" });
  });

  it("知らない差し戻し理由は差し戻しとして読まない", () => {
    const outcome = done({
      status: "applied",
      events: [],
      judgement: { outcome: "reject", reason: "unknown" },
    });
    expect(submitResult(outcome, actionSentBackLine)).toEqual({ kind: "accepted" });
  });

  it.each(["unavailable", "failed"] as const)("%s は送り直せる", (kind) => {
    expect(submitResult({ kind }, summarySentBackLine)).toEqual({ kind: "retry" });
  });

  it.each(["stale", "not-ready", "superseded"] as const)("%s は何も言わない", (kind) => {
    expect(submitResult({ kind }, summarySentBackLine)).toEqual({ kind: "none" });
  });
});
