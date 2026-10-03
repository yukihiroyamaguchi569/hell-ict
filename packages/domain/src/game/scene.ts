import type { GameStageId, PenaltyStatus, TrapStageId } from "../schemas/game.js";

/**
 * Which scene a team's state puts on screen (Issue #238, V1 decision G). Pure: the screen draws
 * the scene and never decides it itself, so a reload lands on the same scene as the team that
 * never left.
 *
 * - welcome: the Prologue before the inbox is opened.
 * - inbox: the Prologue's inbox. Its end leads straight to Stage 1 without a clear effect (mock
 *   `inboxFrame` → `go("s1")`), so a cleared Prologue stays here: moving on is the inbox's job.
 * - stage: a stage in play.
 * - clear-sequence: the current stage is cleared and its `advance` is still to be sent. The screen
 *   plays the clear effect (mock `startClearPopups`) and sends `advance {from: stage, to: next}`.
 *   `handover` adds the fourth sheet asking the team to change who is at the keyboard.
 * - penalty: the trap of the current stage fired and its penalty is being paid.
 * - final: the race is over.
 */
export type TeamGameScene =
  | { readonly kind: "welcome" }
  | { readonly kind: "inbox" }
  | { readonly kind: "stage"; readonly stage: PlayedStageId }
  | {
      readonly kind: "clear-sequence";
      readonly stage: PlayedStageId;
      readonly next: GameStageId;
      readonly handover: boolean;
    }
  | { readonly kind: "penalty"; readonly stage: TrapStageId }
  | { readonly kind: "final" };

export type TeamGameSceneKind = TeamGameScene["kind"];

/** Stages played on the stage screen: neither the Prologue nor Final. */
export type PlayedStageId = Exclude<GameStageId, "prologue" | "final">;

/**
 * Stages after whose clear the team is asked to change who operates the PC (mock HANDOVER_NOTE,
 * Issue #148): three people share one PC and each takes a turn, so two changes are enough.
 */
export const HANDOVER_STAGE_IDS = ["s2", "s4"] as const satisfies readonly PlayedStageId[];

/** The parts of a team's state a scene depends on (the server's state or the screen's view). */
export interface SceneFacts {
  readonly game: {
    readonly stage: GameStageId;
    readonly clearedAt: Readonly<Partial<Record<Exclude<GameStageId, "final">, string>>>;
    readonly penalties: Readonly<Record<TrapStageId, PenaltyStatus>>;
  };
  readonly inbox: unknown;
}

const isTrapStage = (stage: GameStageId): stage is TrapStageId => stage === "s3" || stage === "s5";

const isHandoverStage = (stage: PlayedStageId): boolean =>
  HANDOVER_STAGE_IDS.some((handover) => handover === stage);

/** The stage after each played stage (GAME_STAGE_IDS order; a test keeps the two in step). */
const NEXT_STAGE = {
  s1: "s2",
  s2: "s3",
  s3: "s4",
  s4: "s5",
  s5: "s6",
  s6: "final",
} as const satisfies Readonly<Record<PlayedStageId, GameStageId>>;

const prologueScene = (facts: SceneFacts): TeamGameScene =>
  facts.inbox === null ? { kind: "welcome" } : { kind: "inbox" };

/**
 * The scene of a stage in play. A running penalty comes first: it pins the team to the stage
 * (Issue #92), so even a state that also claims a clear (which the server never writes) shows
 * the penalty and sends no `advance`.
 */
const playedScene = (facts: SceneFacts, stage: PlayedStageId): TeamGameScene => {
  if (isTrapStage(stage) && facts.game.penalties[stage] === "in-progress") {
    return { kind: "penalty", stage };
  }
  if (facts.game.clearedAt[stage] === undefined) return { kind: "stage", stage };
  return {
    kind: "clear-sequence",
    stage,
    next: NEXT_STAGE[stage],
    handover: isHandoverStage(stage),
  };
};

export const teamGameScene = (facts: SceneFacts): TeamGameScene => {
  const { stage } = facts.game;
  if (stage === "prologue") return prologueScene(facts);
  if (stage === "final") return { kind: "final" };
  return playedScene(facts, stage);
};
