import type { StageJudgement } from "../schemas/game.js";

/**
 * A stage judge's result carries its own detail (which field, why). The `record-judgement`
 * command takes only the outcome and its schema is strict, so the detail is dropped here before
 * the result is wrapped into the command.
 */
export const toStageJudgement = (judgement: StageJudgement): StageJudgement => ({
  outcome: judgement.outcome,
});
