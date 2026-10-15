import { stage4Rules } from "@hell-ict/content";

import type { GameEvent, StageJudgement } from "../schemas/game.js";

/**
 * Stage 4 (reading the new report): two judges in sequence, no trap.
 * 1. The summary of the foreign report must pick up the symptom that precedes the fever.
 * 2. After the director's question, the action must name whom to ask and what to ask them.
 *    Only this one clears the stage.
 * Ported from the mock's `checkS4Summary` / `runS4ActionVerdict` and the constants
 * `S4_REQUIRED_SUMMARY` / `S4_ACTION_TARGET` / `S4_ACTION_CONTENT` / `S4_ACTION_PATIENT`
 * (hell-ict-archive:docs/ui/mock/index.html). Pass and reject must match the mock exactly; the mock applies no
 * normalisation, so neither does this. Only the reject reasons are finer than the mock's (#220).
 */

/** The words of the two judges live in content (`stage4Rules`); the order and reasons live here. */
const OCULAR_SYMPTOM_IN_SUMMARY: RegExp = stage4Rules.summary;

/** Whom to ask. */
const ACTION_TARGET: RegExp = stage4Rules.actionTarget;

/** What to ask. Looser than the summary because it is paired with a target. */
const ACTION_CONTENT: RegExp = stage4Rules.actionContent;

/** An action aimed at the wrong people: too late to get ahead of the outbreak. */
const ACTION_PATIENT: RegExp = stage4Rules.actionPatient;

/**
 * The summary does not clear the stage, so its result is deliberately not a `StageJudgement`
 * ("accepted", not "pass"): it cannot be recorded as a clear by mistake.
 */
export type Stage4SummaryJudgement =
  | { outcome: "accepted" }
  | { outcome: "reject"; reason: "no-ocular-symptom" };

export const judgeStage4Summary = (text: string): Stage4SummaryJudgement =>
  OCULAR_SYMPTOM_IN_SUMMARY.test(text)
    ? { outcome: "accepted" }
    : { outcome: "reject", reason: "no-ocular-symptom" };

/**
 * Why an action is sent back. Where it passes is unchanged from the mock; only the mock's single
 * `unclear` is split by what is missing (#220), so the director can point at the missing part.
 * "Whom" is `ACTION_TARGET` only: `ACTION_PATIENT` also matches words that name no one, so it only decides `aimed-at-patients`, which needs the content as before.
 * - aimed-at-patients: the content is right but it asks patients (the director has checked them).
 * - missing-what: it names whom (staff) but not what to ask them.
 * - missing-whom: it says what to ask but names no one (and no patients).
 * - missing-both: neither whom nor what (patient words without content land here).
 */
export const STAGE4_ACTION_REJECT_REASONS = [
  "aimed-at-patients",
  "missing-what",
  "missing-whom",
  "missing-both",
] as const;

export type Stage4ActionRejectReason = (typeof STAGE4_ACTION_REJECT_REASONS)[number];

/** Structurally a `StageJudgement` (the state machine reads only `outcome`). */
export type Stage4ActionJudgement =
  | Extract<StageJudgement, { outcome: "pass" }>
  | (Extract<StageJudgement, { outcome: "reject" }> & { reason: Stage4ActionRejectReason });

const rejectAction = (reason: Stage4ActionRejectReason): Stage4ActionJudgement => ({
  outcome: "reject",
  reason,
});

export const judgeStage4Action = (text: string): Stage4ActionJudgement => {
  const hasContent = ACTION_CONTENT.test(text);
  const hasTarget = ACTION_TARGET.test(text);
  const hasPatient = ACTION_PATIENT.test(text);
  if (hasContent && hasTarget) return { outcome: "pass" };
  if (hasContent) return rejectAction(hasPatient ? "aimed-at-patients" : "missing-whom");
  return rejectAction(hasTarget ? "missing-what" : "missing-both");
};

/**
 * Issue #38: which of Karube's hints a Stage 4 action reject brings, by how many action rejects
 * the team has had, this one included (1st, 2nd, …). Any reject reason counts; a summary reject
 * does not (it never reaches the state machine).
 * - 1st, 2nd: none. The director's line is enough.
 * - 3rd: `who-hint` — he points at people other than the patients, who see the ward every day.
 * - 4th: none.
 * - 5th: `final-push` — he names where in the report to look and whom to have it checked by.
 * - 6th onwards: none. Repeating it would only nag (as Stage 3's #219).
 * The wording lives in content and contains no word the action judge accepts.
 */
export const STAGE4_ACTION_HINTS = ["none", "who-hint", "final-push"] as const;

export type Stage4ActionHint = (typeof STAGE4_ACTION_HINTS)[number];

/** The hint of each action reject (1st, 2nd, …). Later ones than listed bring none. */
const HINT_BY_ACTION_REJECT: readonly Stage4ActionHint[] = [
  "none",
  "none",
  "who-hint",
  "none",
  "final-push",
];

/**
 * The hint the `actionRejects`-th action reject brought (1st, 2nd, …). The screen reads it for
 * every reject so far, so a reload still finds each hint.
 */
export const stage4ActionHint = (actionRejects: number): Stage4ActionHint =>
  HINT_BY_ACTION_REJECT[actionRejects - 1] ?? "none";

/**
 * The number of Stage 4 rejects that one applied command recorded (0 or 1). Only the action is
 * recorded by the state machine, so this counts action rejects alone. A resent command
 * (`duplicate`) has no events and is not counted again.
 */
export const countStage4ActionRejects = (events: readonly GameEvent[]): number =>
  events.filter((event) => event.type === "submission-rejected" && event.stage === "s4").length;
