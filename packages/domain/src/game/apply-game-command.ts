import { gameStagePosition, TRAP_STAGE_IDS } from "../schemas/game.js";
import type {
  AdvanceCommand,
  CompletePenaltyCommand,
  GameCommand,
  GameEvent,
  GameInstant,
  GameRejectionReason,
  GameStageId,
  GameState,
  GameVerdict,
  JudgedStageId,
  RecordJudgementCommand,
  TrapStageId,
} from "../schemas/game.js";

export interface GameCommandResult {
  state: GameState;
  events: GameEvent[];
  verdict: GameVerdict;
}

type Transition =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; reason: GameRejectionReason };

const applied = (state: GameState, events: GameEvent[]): Transition => ({
  ok: true,
  state,
  events,
});

const rejected = (reason: GameRejectionReason): Transition => ({ ok: false, reason });

export const initialGameState = (): GameState => ({
  stage: "prologue",
  clearedAt: {},
  penalties: { s3: "none", s5: "none" },
  processedCommandIds: [],
});

const isTrapStage = (stage: GameStageId): stage is TrapStageId =>
  TRAP_STAGE_IDS.some((trapStage) => trapStage === stage);

const isPenaltyInProgress = (state: GameState): boolean =>
  TRAP_STAGE_IDS.some((stage) => state.penalties[stage] === "in-progress");

/** Final is never cleared: it has no judgement. */
const isCleared = (state: GameState, stage: GameStageId): boolean =>
  stage !== "final" && state.clearedAt[stage] !== undefined;

const judgementBlocker = (state: GameState, stage: JudgedStageId): GameRejectionReason | null => {
  if (stage !== state.stage) return "stage-mismatch";
  if (isPenaltyInProgress(state)) return "penalty-in-progress";
  if (isCleared(state, stage)) return "already-cleared";
  return null;
};

/** The first trap on a stage starts its penalty; later ones only report the repeat (企画書 §6). */
const recordTrap = (state: GameState, stage: JudgedStageId, now: GameInstant): Transition => {
  if (!isTrapStage(stage)) return rejected("trap-not-applicable");
  if (state.penalties[stage] !== "none")
    return applied(state, [{ type: "trap-repeated", stage, at: now }]);
  return applied({ ...state, penalties: { ...state.penalties, [stage]: "in-progress" } }, [
    { type: "trap-triggered", stage, at: now },
  ]);
};

const recordJudgement = (
  state: GameState,
  command: RecordJudgementCommand,
  now: GameInstant,
): Transition => {
  const blocker = judgementBlocker(state, command.stage);
  if (blocker !== null) return rejected(blocker);
  const { stage } = command;
  switch (command.judgement.outcome) {
    case "pass":
      return applied({ ...state, clearedAt: { ...state.clearedAt, [stage]: now } }, [
        { type: "stage-cleared", stage, at: now },
      ]);
    case "reject":
      return applied(state, [{ type: "submission-rejected", stage, at: now }]);
    case "trap":
      return recordTrap(state, stage, now);
  }
};

/**
 * Only one step forward from the current, cleared stage. The penalty check comes before the
 * clear check so that the caller learns the real reason (Issue #92).
 */
const advanceBlocker = (state: GameState, command: AdvanceCommand): GameRejectionReason | null => {
  if (command.from !== state.stage) return "stage-mismatch";
  const step = gameStagePosition(command.to) - gameStagePosition(command.from);
  if (step < 1) return "not-forward";
  if (step > 1) return "skip-forbidden";
  if (isPenaltyInProgress(state)) return "penalty-in-progress";
  if (!isCleared(state, command.from)) return "not-cleared";
  return null;
};

const advance = (state: GameState, command: AdvanceCommand, now: GameInstant): Transition => {
  const blocker = advanceBlocker(state, command);
  if (blocker !== null) return rejected(blocker);
  return applied({ ...state, stage: command.to }, [
    { type: "stage-entered", stage: command.to, at: now },
  ]);
};

const completePenalty = (
  state: GameState,
  command: CompletePenaltyCommand,
  now: GameInstant,
): Transition => {
  const { stage } = command;
  if (state.penalties[stage] !== "in-progress") return rejected("no-penalty-in-progress");
  return applied({ ...state, penalties: { ...state.penalties, [stage]: "done" } }, [
    { type: "penalty-completed", stage, at: now },
  ]);
};

const transition = (state: GameState, command: GameCommand, now: GameInstant): Transition => {
  switch (command.type) {
    case "record-judgement":
      return recordJudgement(state, command, now);
    case "advance":
      return advance(state, command, now);
    case "complete-penalty":
      return completePenalty(state, command, now);
  }
};

/**
 * Applies one command to a team's game state. Pure: the only clock is `now` (the server's
 * time, parsed with `gameInstantSchema`), and nothing outside the returned value changes.
 *
 * A commandId already applied returns the state untouched (`duplicate`). A rejected command
 * leaves no trace — not even its id — so the same command can be resent once it becomes valid.
 * Stage-specific judging (D2〜D4) happens outside; its result enters as `record-judgement`.
 */
export const applyGameCommand = (
  state: GameState,
  command: GameCommand,
  now: GameInstant,
): GameCommandResult => {
  if (state.processedCommandIds.includes(command.commandId)) {
    return { state, events: [], verdict: { status: "duplicate" } };
  }
  const result = transition(state, command, now);
  if (!result.ok)
    return { state, events: [], verdict: { status: "rejected", reason: result.reason } };
  return {
    state: {
      ...result.state,
      processedCommandIds: [...state.processedCommandIds, command.commandId],
    },
    events: result.events,
    verdict: { status: "applied" },
  };
};
