import { z } from "zod";

import { commandIdSchema } from "./team-state.js";

/**
 * Stages in play order. The index is the mock's `pos` (the stop on the leaderboard band):
 * prologue=0 (views entry/welcome/inbox), s1=1 … s6=6, final=7. The mock's `unlock` view
 * belongs to s2. Keep this order in sync with STEPS/POS_TO_VIEW in hell-ict-archive:docs/ui/mock/index.html.
 */
export const GAME_STAGE_IDS = ["prologue", "s1", "s2", "s3", "s4", "s5", "s6", "final"] as const;

export const gameStageIdSchema = z.enum(GAME_STAGE_IDS);

/** Stages that end with a judgement. Final has none (企画書 §7), so it can never be cleared. */
export const judgedStageIdSchema = gameStageIdSchema.exclude(["final"]);

export const JUDGED_STAGE_IDS = judgedStageIdSchema.options;

/** Stages with a trap and its penalty (企画書 §6: one penalty per trap stage at most). */
export const TRAP_STAGE_IDS = ["s3", "s5"] as const;

export const trapStageIdSchema = z.enum(TRAP_STAGE_IDS);

/**
 * Same vocabulary as the checkpoint's `s3Penalty`/`s5Penalty`. The first trap always starts the
 * penalty, so "the trap has fired" is exactly "the penalty is not `none`" — there is no separate
 * used flag that could disagree with it (a used trap without a penalty would let a team skip it).
 */
export const PENALTY_STATUSES = ["none", "in-progress", "done"] as const;

export const penaltyStatusSchema = z.enum(PENALTY_STATUSES);

/**
 * A server-clock instant (ISO 8601). Branded so that `applyGameCommand` only takes a value that
 * went through this schema: an unchecked string would be stored as-is and make the state fail
 * its own schema on the next read.
 */
export const gameInstantSchema = z.iso.datetime().brand<"GameInstant">();

/**
 * The shape of the game state without its invariants. Only for building the screen's view of
 * a response (`schemas/game-api.ts`): zod cannot `.omit()` from a refined object. Anything that
 * stores or transitions the state uses `gameStateSchema`.
 */
export const gameStateShapeSchema = z
  .object({
    /** Where the team is now. Moves only by `advance`, one stage at a time. */
    stage: gameStageIdSchema,
    /** When each stage was passed. The current stage may be cleared while `advance` is pending. */
    clearedAt: z.partialRecord(judgedStageIdSchema, gameInstantSchema),
    penalties: z.object({ s3: penaltyStatusSchema, s5: penaltyStatusSchema }).strict(),
    /** Ids of applied commands, so that a resent command is not applied twice. */
    processedCommandIds: z.array(commandIdSchema),
  })
  .strict();

type GameStateShape = z.infer<typeof gameStateShapeSchema>;

/** The stage's index in play order, which is also the mock's `pos`. */
export const gameStagePosition = (stage: GameStageId): number => GAME_STAGE_IDS.indexOf(stage);

/** Every stage behind the team is cleared and nothing ahead of it is. */
const clearsMatchStage = (state: GameStateShape): boolean =>
  JUDGED_STAGE_IDS.every((stage) => {
    const cleared = state.clearedAt[stage] !== undefined;
    const offset = gameStagePosition(stage) - gameStagePosition(state.stage);
    if (offset < 0) return cleared;
    return offset === 0 || !cleared;
  });

/**
 * A trap cannot fire ahead of the team, and a running penalty pins the team to its own,
 * still uncleared stage (Issue #92).
 */
const penaltyIsConsistent = (state: GameStateShape, stage: TrapStageId): boolean => {
  const penalty = state.penalties[stage];
  if (penalty === "none") return true;
  if (gameStagePosition(stage) > gameStagePosition(state.stage)) return false;
  if (penalty === "done") return true;
  return state.stage === stage && state.clearedAt[stage] === undefined;
};

const commandIdsAreUnique = (state: GameStateShape): boolean =>
  new Set(state.processedCommandIds).size === state.processedCommandIds.length;

/**
 * The whole game state of one team. The invariants are part of the schema so that a state
 * read back from storage cannot put the machine somewhere its own transitions never lead.
 */
export const gameStateSchema = gameStateShapeSchema
  .refine(clearsMatchStage, { message: "clearedAt does not match the current stage" })
  .refine((state) => TRAP_STAGE_IDS.every((stage) => penaltyIsConsistent(state, stage)), {
    message: "penalty state is inconsistent",
  })
  .refine(commandIdsAreUnique, { message: "processedCommandIds has duplicates" });

/**
 * The result of a stage-specific judge (D2〜D4: stages/s1.ts … s6.ts, inbox.ts). The state
 * machine only needs the outcome; a judge may add its own detail per outcome later.
 * - pass: the stage is cleared.
 * - reject: not yet (missing items etc.). Nothing changes.
 * - trap: the trap fired. Only valid on trap stages; the first one starts the penalty.
 */
export const stageJudgementSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("pass") }).strict(),
  z.object({ outcome: z.literal("reject") }).strict(),
  z.object({ outcome: z.literal("trap") }).strict(),
]);

export const recordJudgementCommandSchema = z
  .object({
    type: z.literal("record-judgement"),
    commandId: commandIdSchema,
    stage: judgedStageIdSchema,
    judgement: stageJudgementSchema,
  })
  .strict();

/** `from` makes a resent or stale advance fail instead of moving the team twice. */
export const advanceCommandSchema = z
  .object({
    type: z.literal("advance"),
    commandId: commandIdSchema,
    from: gameStageIdSchema,
    to: gameStageIdSchema,
  })
  .strict();

export const completePenaltyCommandSchema = z
  .object({
    type: z.literal("complete-penalty"),
    commandId: commandIdSchema,
    stage: trapStageIdSchema,
  })
  .strict();

export const gameCommandSchema = z.discriminatedUnion("type", [
  recordJudgementCommandSchema,
  advanceCommandSchema,
  completePenaltyCommandSchema,
]);

export const gameEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("stage-cleared"), stage: judgedStageIdSchema, at: gameInstantSchema })
    .strict(),
  z
    .object({
      type: z.literal("submission-rejected"),
      stage: judgedStageIdSchema,
      at: gameInstantSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("trap-triggered"), stage: trapStageIdSchema, at: gameInstantSchema })
    .strict(),
  z
    .object({ type: z.literal("trap-repeated"), stage: trapStageIdSchema, at: gameInstantSchema })
    .strict(),
  z
    .object({
      type: z.literal("penalty-completed"),
      stage: trapStageIdSchema,
      at: gameInstantSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("stage-entered"), stage: gameStageIdSchema, at: gameInstantSchema })
    .strict(),
]);

export const GAME_REJECTION_REASONS = [
  // The command names a stage other than the current one (a stale tab, a late resend).
  "stage-mismatch",
  "already-cleared",
  // Issue #92: nothing moves on while a penalty is being paid.
  "penalty-in-progress",
  "not-cleared",
  // `advance` to the same or an earlier stage.
  "not-forward",
  "skip-forbidden",
  "trap-not-applicable",
  "no-penalty-in-progress",
] as const;

export const gameRejectionReasonSchema = z.enum(GAME_REJECTION_REASONS);

export const gameVerdictSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied") }).strict(),
  // Same commandId as an applied command: nothing is applied again.
  z.object({ status: z.literal("duplicate") }).strict(),
  z.object({ status: z.literal("rejected"), reason: gameRejectionReasonSchema }).strict(),
]);

export type GameStageId = z.infer<typeof gameStageIdSchema>;
export type JudgedStageId = z.infer<typeof judgedStageIdSchema>;
export type TrapStageId = z.infer<typeof trapStageIdSchema>;
export type GameInstant = z.infer<typeof gameInstantSchema>;
export type PenaltyStatus = z.infer<typeof penaltyStatusSchema>;
export type GameState = z.infer<typeof gameStateSchema>;
export type StageJudgement = z.infer<typeof stageJudgementSchema>;
export type RecordJudgementCommand = z.infer<typeof recordJudgementCommandSchema>;
export type AdvanceCommand = z.infer<typeof advanceCommandSchema>;
export type CompletePenaltyCommand = z.infer<typeof completePenaltyCommandSchema>;
export type GameCommand = z.infer<typeof gameCommandSchema>;
export type GameEvent = z.infer<typeof gameEventSchema>;
export type GameRejectionReason = z.infer<typeof gameRejectionReasonSchema>;
export type GameVerdict = z.infer<typeof gameVerdictSchema>;
