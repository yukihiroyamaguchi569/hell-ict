import {
  stage5JimuMail,
  stage5Labels,
  stage5ReportVerdicts,
  stage5SendFailed,
  stage5SubmissionRejectLines,
} from "@hell-ict/content";
import { stage5DeadlineAt } from "@hell-ict/domain";
import type { GameCommandResponse, TeamGameViewState } from "@hell-ict/domain";
import { z } from "zod";

import type { SendOutcome } from "../../composables/use-game-session.js";
import type { MissionDeadline } from "../../shell/mission-bar-view.js";
import type { Verdict } from "../../verdict/verdict.js";
import type { InboxRow } from "../stage-module.js";

/*
 * Stage 5's pure parts: the inbox, what an answer to `s5.submit` or `s5.submit-report` means for
 * the screen, and which window the stage layer shows. The trap itself is the server's (the gate
 * in front of the AI chat stops personal data before OpenAI): nothing here decides or imitates
 * it. No result carries the submitted text.
 */

/** The head of administration's request: pressing it opens the fever list in the viewer. */
export const STAGE5_ROWS: readonly InboxRow[] = [
  {
    id: "s5jimu",
    from: stage5JimuMail.from,
    subject: stage5JimuMail.subj,
    attach: stage5JimuMail.attach,
    opens: { kind: "viewer", doc: "s5list" },
  },
];

/**
 * What an answer to the submission or the report means.
 * - passed: it went through (the stage is cleared, or the penalty paid).
 * - sent-back: with what is wrong, every reason at once (#221). Free and unlimited.
 * - retry: it may not have arrived; pressing again resends it under the same commandId.
 * - none: nothing to say (a stale tab, the team has moved on, the penalty paid elsewhere, an
 *   unreadable answer).
 */
export type SubmitResult =
  | { readonly kind: "passed" | "retry" | "none" }
  | { readonly kind: "sent-back"; readonly lines: readonly string[] };

/** A lost send is `retry`, one refused before the server saw it `none`; the rest is `read`. */
const readAnswer = (
  outcome: SendOutcome,
  read: (response: GameCommandResponse) => SubmitResult,
): SubmitResult => {
  if (outcome.kind === "unavailable" || outcome.kind === "failed") return { kind: "retry" };
  return outcome.kind === "done" ? read(outcome.response) : { kind: "none" };
};

const submissionJudgementSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("pass") }),
  z.object({
    outcome: z.literal("reject"),
    reasons: z
      .array(
        z.union([
          z.object({ reason: z.literal("ids"), missingIds: z.array(z.string()) }),
          z.object({ reason: z.enum(["fullwidth", "date", "temp"]) }),
        ]),
      )
      .min(1),
  }),
]);

/** The submission to the health centre. A resend's `duplicate` brings the first judgement. */
export const stage5Result = (outcome: SendOutcome): SubmitResult =>
  readAnswer(outcome, (response) => {
    const judgement = submissionJudgementSchema.safeParse(
      response.status === "duplicate" ? response.original.judgement : response.judgement,
    );
    if (!judgement.success) return { kind: "none" };
    return judgement.data.outcome === "pass"
      ? { kind: "passed" }
      : { kind: "sent-back", lines: stage5SubmissionRejectLines(judgement.data.reasons) };
  });

const reportRejectSchema = z
  .object({ outcome: z.literal("reject"), missing: z.boolean(), over: z.boolean() })
  .refine((judgement) => judgement.missing || judgement.over);

/** What is wrong with the report: both at once when both are (mock submitReport). */
export const reportRejectLines = (judgement: {
  readonly missing: boolean;
  readonly over: boolean;
}): readonly string[] => [
  ...(judgement.missing ? [stage5ReportVerdicts.missing] : []),
  ...(judgement.over ? [stage5ReportVerdicts.over] : []),
];

const reportPassSchema = z.object({ outcome: z.literal("pass") });

/**
 * The blacked-out report: `report-incomplete` says what is wrong with it. A resend's `duplicate`
 * is read by its first judgement, never taken as passed on its own.
 */
export const reportResult = (outcome: SendOutcome): SubmitResult =>
  readAnswer(outcome, (response) => {
    if (response.status === "applied") return { kind: "passed" };
    const incomplete = response.status === "duplicate" || response.reason === "report-incomplete";
    const judgement =
      response.status === "duplicate" ? response.original.judgement : response.judgement;
    const sentBack = reportRejectSchema.safeParse(judgement);
    if (incomplete && sentBack.success) {
      return { kind: "sent-back", lines: reportRejectLines(sentBack.data) };
    }
    const passedBefore =
      response.status === "duplicate" && reportPassSchema.safeParse(judgement).success;
    return { kind: passedBefore ? "passed" : "none" };
  });

/** The verdict box under a submission (`null`: none). `passedText` is its line once through. */
export const submitVerdict = (
  sending: boolean,
  result: SubmitResult | null,
  passedText: string,
): Verdict | null => {
  if (sending) return { kind: "checking" };
  switch (result?.kind) {
    case "passed":
      return { kind: "cleared", text: passedText };
    case "sent-back":
      return { kind: "rejected", lines: result.lines };
    case "retry":
      return { kind: "rejected", lines: [stage5SendFailed] };
    default:
      return null;
  }
};

/**
 * The head of administration's call when the deadline passes: once per stay (`rangIn` is the
 * entry of the stay it rang in, `seenIn` the one it was closed in), and never after the clear.
 */
export const stage5CallWanted = (
  state: TeamGameViewState,
  rangIn: string | null,
  seenIn: string | null,
): boolean => {
  const entered = state.enteredAt.s5;
  return (
    entered !== undefined &&
    state.game.clearedAt.s5 === undefined &&
    rangIn === entered &&
    seenIn !== entered
  );
};

/**
 * - alarm, scold: the trap's first firing, played only in the tab that saw it fire.
 * - penalty: the report, as long as the server has the penalty running (a reload lands here),
 *   and a moment longer while 「送信しました」 shows (`penaltyHeld`).
 * - call: the deadline's call, held back behind the penalty (user decision 7) and while a
 *   submission is on its way (its answer may be the clear).
 */
export type Stage5Overlay = "alarm" | "scold" | "penalty" | "call" | null;

export interface Stage5OverlayFacts {
  readonly state: TeamGameViewState;
  readonly trapScene: "alarm" | "scold" | null;
  readonly penaltyHeld: boolean;
  readonly callWanted: boolean;
  readonly submitting: boolean;
}

export const stage5Overlay = (facts: Stage5OverlayFacts): Stage5Overlay => {
  if (facts.state.game.stage !== "s5") return null;
  const running = facts.state.game.penalties.s5 === "in-progress";
  if (running && facts.trapScene !== null) return facts.trapScene;
  if (running || facts.penaltyHeld) return "penalty";
  return facts.callWanted && !facts.submitting ? "call" : null;
};

/**
 * The health centre's deadline in the mission bar (user decision 6; mock #s5-dl), counted from
 * the entry into Stage 5. Gone once the stage is cleared: the mock stops it at the clear.
 */
export const stage5MissionDeadline = (state: TeamGameViewState): MissionDeadline | null => {
  const entered = state.enteredAt.s5;
  if (state.game.stage !== "s5" || entered === undefined) return null;
  if (state.game.clearedAt.s5 !== undefined) return null;
  return {
    at: stage5DeadlineAt(entered),
    label: stage5Labels.deadline,
    overText: stage5Labels.deadlineOver,
  };
};
