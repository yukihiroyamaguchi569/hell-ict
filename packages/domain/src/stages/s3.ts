import { type stage3FieldIds, stage3Rules } from "@hell-ict/content";
import { z } from "zod";

import type { GameEvent, StageJudgement } from "../schemas/game.js";

/**
 * Stage 3: the judge of the three-field submission.
 * Ported from the mock's `checkStage3` and its constants `S3_REQUIRED` / `S3_TRAP` / `S3_ORDER`
 * (hell-ict-archive:docs/ui/mock/index.html). The behaviour must match the mock exactly; the mock applies no
 * normalisation, so neither does this (full-width digits, "50°C" etc. are read as written).
 */

/**
 * The fields in on-screen order. When several fields are wrong, the first one is reported.
 * `satisfies` keeps them identical to the fields content's rules are written for, both ways.
 */
export const STAGE3_FIELD_IDS = [
  "ppe",
  "release",
  "clean",
] as const satisfies typeof stage3FieldIds;

export const stage3FieldIdSchema = z.enum(STAGE3_FIELD_IDS);

export type Stage3FieldId = z.infer<typeof stage3FieldIdSchema>;

/** What the team submits: the free text of each field. Same keys as the mock's `submit.s3` log. */
export const stage3SubmissionSchema = z
  .object({ ppe: z.string(), release: z.string(), clean: z.string() })
  .strict();

export type Stage3Submission = z.infer<typeof stage3SubmissionSchema>;

/** Every pattern of a field must match for the field to be enough (the words live in content). */
const REQUIRED: Record<Stage3FieldId, readonly RegExp[]> = stage3Rules.required;

/** The trap words of each field and the right words that cancel them (content's `traps`). */
const TRAP_WORDS: Record<Stage3FieldId, { words: RegExp; unless: RegExp }> = stage3Rules.traps;

/**
 * Trap patterns: each is "a trap word AND no right word". A submission that correctly negates
 * the over-reaction is evidence of reading the manual, not a trap.
 */
const isTrap = (field: Stage3FieldId, text: string): boolean => {
  const { words, unless } = TRAP_WORDS[field];
  return words.test(text) && !unless.test(text);
};

/** The fabricated source of the contaminated material. Caught in whichever field it is pasted. */
const citesFabricatedSource = (text: string): boolean => stage3Rules.fabricatedSource.test(text);

/**
 * The result of one Stage 3 submission. Structurally a `StageJudgement` (the state machine reads
 * only `outcome`); `field` says which field to point at, as an id — the wording lives in content.
 * The judge does not know whether the trap has fired before: a repeated trap is still `trap`, and
 * the state machine decides that no second penalty starts.
 */
export type Stage3Judgement =
  | Extract<StageJudgement, { outcome: "pass" }>
  | (Extract<StageJudgement, { outcome: "reject" }> & { field: Stage3FieldId })
  | (Extract<StageJudgement, { outcome: "trap" }> & { field: Stage3FieldId });

const findField = (predicate: (field: Stage3FieldId) => boolean): Stage3FieldId | undefined =>
  STAGE3_FIELD_IDS.find(predicate);

const isShort = (submission: Stage3Submission, field: Stage3FieldId): boolean =>
  !REQUIRED[field].every((pattern) => pattern.test(submission[field]));

/**
 * The trap is checked before anything is judged missing, and the fabricated source before the
 * per-field traps (the mock's order). Pure: the same submission always gives the same result.
 */
export const judgeStage3 = (submission: Stage3Submission): Stage3Judgement => {
  const cited = findField((field) => citesFabricatedSource(submission[field]));
  if (cited !== undefined) return { outcome: "trap", field: cited };
  const trapped = findField((field) => isTrap(field, submission[field]));
  if (trapped !== undefined) return { outcome: "trap", field: trapped };
  const short = findField((field) => isShort(submission, field));
  if (short !== undefined) return { outcome: "reject", field: short };
  return { outcome: "pass" };
};

/**
 * Issue #219: which of Karube's hints a Stage 3 trap judgement brings, by how many trap
 * judgements the team has had on this stage, this one included (1st, 2nd, …).
 * - 1st: none. The penalty starts and the dermatologist speaks.
 * - 2nd and 3rd: `type-hint` — he asks whether they checked the disease type (病型).
 * - 4th: `final-push` — he names the manual's sections to open.
 * - 5th onwards: none. He has said all he can; repeating it would only nag (user decision
 *   2026-09-27). Only the screen's own "not right yet" message is left.
 * The hints only point at the manual; the wording lives in content and gives no answer.
 */
export const STAGE3_TRAP_HINTS = ["none", "type-hint", "final-push"] as const;

export const stage3TrapHintSchema = z.enum(STAGE3_TRAP_HINTS);

export type Stage3TrapHint = z.infer<typeof stage3TrapHintSchema>;

/** The hint of each trap judgement (1st, 2nd, …). Later ones than listed bring none. */
const HINT_BY_TRAP_JUDGEMENT: readonly Stage3TrapHint[] = [
  "none",
  "type-hint",
  "type-hint",
  "final-push",
];

/**
 * The hint the `trapJudgements`-th trap judgement brought (1st, 2nd, …). The screen reads it
 * for every judgement so far, so a reload still finds each hint.
 */
export const stage3TrapHintOfJudgement = (trapJudgements: number): Stage3TrapHint =>
  HINT_BY_TRAP_JUDGEMENT[trapJudgements - 1] ?? "none";

/** The number of Stage 3 trap judgements that one applied command recorded (0 or 1). */
export const countStage3TrapJudgements = (events: readonly GameEvent[]): number =>
  events.filter(
    (event) =>
      (event.type === "trap-triggered" || event.type === "trap-repeated") && event.stage === "s3",
  ).length;

/**
 * The hint for ONE applied command: `events` are its events and `trapJudgements` the team's
 * count after it (TeamGameState `s3.trapJudgements`).
 *
 * - A command that recorded no Stage 3 trap brings no hint. A `reject` or a `pass` is not a trap,
 *   and a resent (`duplicate`) or rejected command (a trap sent during the penalty) has no events,
 *   so none of them is counted, and no submission brings a hint twice.
 * - A `reject` between traps does not reset the count. A reject means no field held a trap word
 *   at that moment, so a trap after it is the team going back to the over-reaction — what the
 *   hints are for. (On 2026-09-26 no team had trap → reject → trap.)
 */
export const stage3TrapHint = (
  events: readonly GameEvent[],
  trapJudgements: number,
): Stage3TrapHint => {
  if (countStage3TrapJudgements(events) === 0) return "none";
  return stage3TrapHintOfJudgement(trapJudgements);
};
