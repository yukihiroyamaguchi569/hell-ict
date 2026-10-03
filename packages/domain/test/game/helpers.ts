import { applyGameCommand, initialGameState } from "../../src/game/apply-game-command.js";
import { GAME_STAGE_IDS, gameInstantSchema } from "../../src/schemas/game.js";
import type {
  GameCommand,
  GameStageId,
  GameState,
  JudgedStageId,
  StageJudgement,
  TrapStageId,
} from "../../src/schemas/game.js";

export const NOW = gameInstantSchema.parse("2026-10-31T01:00:00.000Z");
export const LATER = gameInstantSchema.parse("2026-10-31T01:05:00.000Z");

let counter = 0;

/** A fresh, valid UUID per call so that helper-built commands never collide. */
export const nextId = (): string => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
};

export const judge = (
  stage: JudgedStageId,
  outcome: StageJudgement["outcome"],
  commandId = nextId(),
): GameCommand => ({ type: "record-judgement", commandId, stage, judgement: { outcome } });

export const advance = (from: GameStageId, to: GameStageId, commandId = nextId()): GameCommand => ({
  type: "advance",
  commandId,
  from,
  to,
});

export const completePenalty = (stage: TrapStageId, commandId = nextId()): GameCommand => ({
  type: "complete-penalty",
  commandId,
  stage,
});

/** Applies commands in order and fails loudly if any of them is not applied. */
export const play = (state: GameState, commands: GameCommand[], now = NOW): GameState =>
  commands.reduce((current, command) => {
    const result = applyGameCommand(current, command, now);
    if (result.verdict.status !== "applied") {
      throw new Error(`${command.type} was not applied: ${JSON.stringify(result.verdict)}`);
    }
    return result.state;
  }, state);

/** The state of a team that has just entered `stage` by the regular route, without traps. */
export const enteredStage = (stage: GameStageId): GameState => {
  const target = GAME_STAGE_IDS.indexOf(stage);
  const commands = GAME_STAGE_IDS.slice(0, target).flatMap((from, index) => {
    const to = GAME_STAGE_IDS[index + 1] ?? "final";
    return from === "final" ? [] : [judge(from, "pass"), advance(from, to)];
  });
  return play(initialGameState(), commands);
};
