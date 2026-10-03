import { stage3Answers, stage4Answers } from "@hell-ict/content/answers";
import { describe, expect, it } from "vitest";

import { applyGameCommand } from "../../src/game/apply-game-command.js";
import { recordJudgementCommandSchema } from "../../src/schemas/game.js";
import { judgeStage3 } from "../../src/stages/s3.js";
import type { Stage3Submission } from "../../src/stages/s3.js";
import { judgeStage4Action } from "../../src/stages/s4.js";
import { toStageJudgement } from "../../src/stages/stage-judgement.js";
import { enteredStage, NOW, nextId } from "../game/helpers.js";

const submission = (fields: Partial<Stage3Submission>): Stage3Submission => ({
  ...stage3Answers.ok,
  ...fields,
});

const TRAPPED = submission({ ppe: stage3Answers.trap.ppe });

const command = (stage: "s3" | "s4", judgement: unknown): unknown => ({
  type: "record-judgement",
  commandId: nextId(),
  stage,
  judgement,
});

describe("toStageJudgement: 判定の詳細を落として record-judgement に包める形にする", () => {
  it.each([
    ["S3 の罠（field 付き）", "s3", judgeStage3(TRAPPED)],
    ["S3 の差し戻し（field 付き）", "s3", judgeStage3(submission({ clean: "" }))],
    ["S3 の合格", "s3", judgeStage3(submission({}))],
    ["S4 の差し戻し（reason 付き）", "s4", judgeStage4Action("")],
    ["S4 の合格", "s4", judgeStage4Action(stage4Answers.actionOk)],
  ] as const)("%s", (_label, stage, judgement) => {
    const converted = toStageJudgement(judgement);
    expect(converted).toEqual({ outcome: judgement.outcome });
    expect(recordJudgementCommandSchema.safeParse(command(stage, converted)).success).toBe(true);
  });

  it("詳細付きのまま包むと strict な schema に拒否される（変換が要る理由）", () => {
    const judgement = judgeStage3(TRAPPED);
    expect(recordJudgementCommandSchema.safeParse(command("s3", judgement)).success).toBe(false);
  });

  it("変換した罠の判定で、状態機械が罰を始める", () => {
    const judgement = toStageJudgement(judgeStage3(TRAPPED));
    const parsed = recordJudgementCommandSchema.parse(command("s3", judgement));
    const result = applyGameCommand(enteredStage("s3"), parsed, NOW);
    expect(result.verdict).toEqual({ status: "applied" });
    expect(result.state.penalties.s3).toBe("in-progress");
  });
});
