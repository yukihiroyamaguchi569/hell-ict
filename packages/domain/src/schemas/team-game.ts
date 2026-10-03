import { z } from "zod";

import { inboxMailIdSchema, inboxStateSchema } from "../stages/inbox.js";
import { stage1MailIdSchema, stage1StateSchema } from "../stages/s1.js";
import { stage2GridSchema } from "../stages/s2-table.js";
import { stage2StateSchema } from "../stages/s2.js";
import { stage3SubmissionSchema } from "../stages/s3.js";
import { S6_POSTER_TYPES } from "../stages/s6.js";
import { CHAT_MESSAGE_MAX_CHARS } from "./chat.js";
import {
  gameEventSchema,
  gameInstantSchema,
  gameStageIdSchema,
  gameStagePosition,
  gameStateSchema,
  gameStateShapeSchema,
} from "./game.js";
import { commandIdSchema, resetGenerationSchema } from "./team-state.js";

/** Stages a team enters by `advance` (the Prologue is where it starts). */
const enteredStageIdSchema = gameStageIdSchema.exclude(["prologue"]);

/** Every stage entered is behind or at the current one, and the current one has its entry. */
const entriesMatchStage = (state: {
  game: { stage: z.infer<typeof gameStageIdSchema> };
  enteredAt: Partial<Record<z.infer<typeof enteredStageIdSchema>, string>>;
}): boolean => {
  const current = gameStagePosition(state.game.stage);
  const behind = enteredStageIdSchema.options.every(
    (stage) => state.enteredAt[stage] === undefined || gameStagePosition(stage) <= current,
  );
  return (
    behind && (state.game.stage === "prologue" || state.enteredAt[state.game.stage] !== undefined)
  );
};

/** The Stage 6 log without its invariant (see `teamGameStateSchema`). */
const s6ShapeSchema = z
  .object({
    promptLog: z.array(z.string()),
    candidates: z.array(z.enum(S6_POSTER_TYPES)),
  })
  .strict();

/** Every part of a team's state but D1's machine (`game`) and the Stage 6 log. */
const teamGameStateFields = {
  startedAt: gameInstantSchema,
  enteredAt: z.partialRecord(enteredStageIdSchema, gameInstantSchema),
  inbox: inboxStateSchema.nullable(),
  s1: stage1StateSchema.nullable(),
  s2: stage2StateSchema.nullable(),
  /**
   * s3.trapJudgements: how many trap judgements the team has had on Stage 3 (Issue #219: which
   * of Karube's hints to give). Missing in states saved before it existed: read as 0, and
   * `stage3TrapJudgementsSoFar` then counts the trap that already fired.
   */
  s3: z
    .object({ trapJudgements: z.number().int().nonnegative() })
    .strict()
    .default({ trapJudgements: 0 }),
  s4: z.object({ summaryAccepted: z.boolean() }).strict(),
};

/**
 * The whole game of one team as the server keeps it (Issue #234): D1's state machine plus the
 * state that only some stages have. Stored in the TeamRoom Durable Object; the screen reads it
 * back with `GET /api/teams/:code/game` and never keeps its own copy of the truth.
 *
 * - startedAt: when the game was created (the team is in the Prologue from then on).
 * - enteredAt: when the team entered each later stage. `final` is the goal time of the race.
 * - inbox / s1 / s2: the timed stages, `null` until the team opens them (the clock starts then).
 * - s4.summaryAccepted: the summary of the foreign report came first and passed.
 * - s6: every instruction sent to the image AI in this stage, and the candidates it made. The
 *   judge reads the whole log (teams add requirements one instruction at a time).
 *
 * Submitted texts of Stage 3 and Stage 5 are judged and dropped: nothing here holds them.
 */
export const teamGameStateSchema = z
  .object({
    game: gameStateSchema,
    ...teamGameStateFields,
    s6: s6ShapeSchema.refine((s6) => s6.promptLog.length === s6.candidates.length, {
      message: "every prompt makes exactly one candidate",
    }),
  })
  .strict()
  .refine(entriesMatchStage, { message: "enteredAt does not match the current stage" })
  .refine((state) => state.s3.trapJudgements === 0 || state.game.penalties.s3 !== "none", {
    message: "Stage 3 trap judgements without the trap having fired",
  });

export type TeamGameState = z.infer<typeof teamGameStateSchema>;

/**
 * The state as `GET /api/teams/:code/game` shows it: D1's processed command ids are left out
 * (`gameView` in the Worker). The shape only — the screen checks what it receives, the server
 * keeps the invariants (`teamGameStateSchema`).
 */
export const teamGameViewStateSchema = z
  .object({
    game: gameStateShapeSchema.omit({ processedCommandIds: true }),
    ...teamGameStateFields,
    s6: s6ShapeSchema,
  })
  .strict();

export type TeamGameViewState = z.infer<typeof teamGameViewStateSchema>;

/** A reply or an instruction. The same ceiling as a chat message. */
const textSchema = z.string().max(CHAT_MESSAGE_MAX_CHARS);

/**
 * Every command carries the reset generation the client got when it joined, as the other
 * writes do: a tab opened before the game master's reset must not write into the new game.
 */
const commandBase = { commandId: commandIdSchema, generation: resetGenerationSchema };

/**
 * What the screen sends (`POST /api/teams/:code/game/commands`). Each type is one button of the
 * mock. The server runs the stage's judge on it and, where the judge decides the stage, wraps
 * the outcome into D1's `record-judgement`. `advance` and the end of the Stage 3 penalty go to
 * the state machine as they are; the Stage 5 penalty ends only when the blacked-out report passes.
 */
export const teamGameCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inbox.open"), ...commandBase }).strict(),
  z
    .object({
      type: z.literal("inbox.reply"),
      ...commandBase,
      mailId: inboxMailIdSchema,
      text: textSchema,
    })
    .strict(),
  // The deadline passed with mails still open: the Prologue ends on the clock.
  z.object({ type: z.literal("inbox.settle"), ...commandBase }).strict(),
  z.object({ type: z.literal("s1.start"), ...commandBase }).strict(),
  z
    .object({
      type: z.literal("s1.reply"),
      ...commandBase,
      mailId: stage1MailIdSchema,
      text: textSchema,
    })
    .strict(),
  z.object({ type: z.literal("s1.memo-reply"), ...commandBase, text: textSchema }).strict(),
  // A round is over on the clock (every mail landed, none open).
  z.object({ type: z.literal("s1.settle"), ...commandBase }).strict(),
  // The button of a failed round's window: R1→R2, R2→R3, R3→R3 again.
  z.object({ type: z.literal("s1.next-round"), ...commandBase }).strict(),
  z.object({ type: z.literal("s2.start"), ...commandBase }).strict(),
  z.object({ type: z.literal("s2.take-addendum"), ...commandBase }).strict(),
  z
    .object({ type: z.literal("s2.submit"), ...commandBase, grid: stage2GridSchema.max(200) })
    .strict(),
  z
    .object({ type: z.literal("s3.submit"), ...commandBase, submission: stage3SubmissionSchema })
    .strict(),
  z.object({ type: z.literal("s3.finish-penalty"), ...commandBase }).strict(),
  z.object({ type: z.literal("s4.submit-summary"), ...commandBase, text: textSchema }).strict(),
  z.object({ type: z.literal("s4.submit-action"), ...commandBase, text: textSchema }).strict(),
  // The PII gate of the Stage 5 AI chat: a hit is the trap. The text is not stored.
  z.object({ type: z.literal("s5.check-ai-message"), ...commandBase, text: z.string() }).strict(),
  z.object({ type: z.literal("s5.submit"), ...commandBase, text: z.string() }).strict(),
  z
    .object({
      type: z.literal("s5.submit-report"),
      ...commandBase,
      maskedIndices: z.array(z.number().int().nonnegative()).max(1_000),
    })
    .strict(),
  z.object({ type: z.literal("s6.generate"), ...commandBase, prompt: textSchema }).strict(),
  z
    .object({
      type: z.literal("s6.submit"),
      ...commandBase,
      candidateIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("advance"),
      ...commandBase,
      from: gameStageIdSchema,
      to: gameStageIdSchema,
    })
    .strict(),
]);

export type TeamGameCommand = z.infer<typeof teamGameCommandSchema>;
export type TeamGameCommandType = TeamGameCommand["type"];

/**
 * Why a command changed nothing. D1's reasons, the stage judges' own ones, and those of the
 * steps around them. The screen picks its wording from content by this id.
 */
export const TEAM_GAME_REJECTION_REASONS = [
  // D1's state machine (GAME_REJECTION_REASONS).
  "stage-mismatch",
  "already-cleared",
  "penalty-in-progress",
  "not-cleared",
  "not-forward",
  "skip-forbidden",
  "trap-not-applicable",
  "no-penalty-in-progress",
  // Replies of the inbox and Stage 1 (INBOX_REPLY_REJECT_REASONS, STAGE1_REPLY_REJECT_REASONS).
  // `not-landed` is also the Stage 2 addendum taken before it landed.
  "round-over",
  "not-in-round",
  "not-landed",
  "already-sent",
  "expired",
  "empty",
  // The steps around the judges.
  "already-started",
  "not-started",
  "mails-open",
  "round-not-over",
  "no-round-result",
  "already-taken",
  "no-ocular-symptom",
  "summary-first",
  "report-incomplete",
  "copied-from-mail",
  "no-candidate",
] as const;

export const teamGameRejectionReasonSchema = z.enum(TEAM_GAME_REJECTION_REASONS);

export type TeamGameRejectionReason = z.infer<typeof teamGameRejectionReasonSchema>;

/**
 * A stage judge's full result: which field, which reason, which cells. Ids and numbers only —
 * never the submitted text. Kept as JSON so that each judge keeps its own type (see stages/*).
 */
export const teamGameJudgementSchema = z.json().nullable();

/**
 * The part of a command's result that the server keeps for a resent command (the judgement and
 * the events). The state is not kept: a resend gets the state as it is now.
 */
export const teamGameOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      events: z.array(gameEventSchema),
      judgement: teamGameJudgementSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: teamGameRejectionReasonSchema,
      judgement: teamGameJudgementSchema,
    })
    .strict(),
]);

export type TeamGameOutcome = z.infer<typeof teamGameOutcomeSchema>;

/** Where a team stands in the race (`teamGameStanding`), as the leaderboard keeps it. */
export const teamGameStandingSchema = z
  .object({
    stage: gameStageIdSchema,
    /** The stop on the race band (the mock's `pos`, 0〜7). */
    pos: z.number().int().min(0).max(gameStagePosition("final")),
    /**
     * When the team reached `pos`: the clear that moved it there (the game's start for 0).
     * Teams on the same stop are ranked by this, not by their latest action (Issue #159).
     */
    reachedAt: gameInstantSchema,
    /** When the team entered Final: the goal of the race. `null` until then. */
    finishedAt: gameInstantSchema.nullable(),
  })
  .strict();

export type TeamGameStanding = z.infer<typeof teamGameStandingSchema>;
