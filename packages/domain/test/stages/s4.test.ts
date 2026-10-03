import { stage4ActionRejects } from "@hell-ict/content";
import { stage4Answers } from "@hell-ict/content/answers";
import { describe, expect, it } from "vitest";

import { stageJudgementSchema } from "../../src/schemas/game.js";
import {
  judgeStage4Action,
  judgeStage4Summary,
  STAGE4_ACTION_REJECT_REASONS,
} from "../../src/stages/s4.js";
import type { Stage4ActionJudgement } from "../../src/stages/s4.js";

/*
 * The judges' branches through the scenario's answers, so they hold for any scenario.
 * The real scenario's word boundaries are tested in the private hell-ict-scenario repo.
 */

const {
  summaryOk,
  summaryNg,
  actionOk,
  actionAimedAtPatients,
  actionMissingWhat,
  actionMissingWhom,
  actionMissingBoth,
} = stage4Answers;

const ACTION_CASES: readonly (readonly [string, string, Stage4ActionJudgement])[] = [
  ["対象と内容が揃う", actionOk, { outcome: "pass" }],
  ["患者に向けた", actionAimedAtPatients, { outcome: "reject", reason: "aimed-at-patients" }],
  ["何を聞くかが無い", actionMissingWhat, { outcome: "reject", reason: "missing-what" }],
  ["誰に聞くかが無い", actionMissingWhom, { outcome: "reject", reason: "missing-whom" }],
  ["どちらも無い", actionMissingBoth, { outcome: "reject", reason: "missing-both" }],
  ["空", "", { outcome: "reject", reason: "missing-both" }],
  ["空白だけ", " 　\n", { outcome: "reject", reason: "missing-both" }],
  // Whom and what may sit on different lines or in different sentences.
  [
    "対象だけの文と内容だけの文を合わせる",
    `${actionMissingWhat}\n${actionMissingWhom}`,
    { outcome: "pass" },
  ],
  // Patients alongside the right target do not send it back.
  ["正解に患者向けの文を足す", `${actionOk}${actionAimedAtPatients}`, { outcome: "pass" }],
];

describe("judgeStage4Summary", () => {
  it.each([
    ["正解", summaryOk, { outcome: "accepted" }],
    ["先行症状に触れない", summaryNg, { outcome: "reject", reason: "no-ocular-symptom" }],
    ["空", "", { outcome: "reject", reason: "no-ocular-symptom" }],
    ["空白だけ", " 　\n", { outcome: "reject", reason: "no-ocular-symptom" }],
    ["複数行の途中に正解がある", `要約\n${summaryNg}\n${summaryOk}\n以上`, { outcome: "accepted" }],
  ] as const)("%s", (_name, text, expected) => {
    expect(judgeStage4Summary(text)).toEqual(expected);
  });

  it("要約の通過はステージのクリアではない（StageJudgement として記録できない）", () => {
    const { outcome } = judgeStage4Summary(summaryOk);
    expect(outcome).toBe("accepted");
    expect(stageJudgementSchema.safeParse({ outcome }).success).toBe(false);
  });
});

describe("judgeStage4Action: 差し戻しの理由は欠けている要素で分ける（#220）", () => {
  it.each(ACTION_CASES)("%s", (_name, text, expected) => {
    expect(judgeStage4Action(text)).toEqual(expected);
  });

  it("差し戻しの理由は4つとも返る（使われない理由を残さない）", () => {
    const reasons = new Set(
      ACTION_CASES.flatMap(([, text]) => {
        const judgement = judgeStage4Action(text);
        return judgement.outcome === "reject" ? [judgement.reason] : [];
      }),
    );
    expect([...reasons].sort()).toEqual([...STAGE4_ACTION_REJECT_REASONS].sort());
  });

  it("状態機械へ渡す StageJudgement は outcome だけで schema を満たし、trap を返さない", () => {
    for (const [, text] of ACTION_CASES) {
      const { outcome } = judgeStage4Action(text);
      expect(stageJudgementSchema.safeParse({ outcome }).success).toBe(true);
      expect(outcome).not.toBe("trap");
    }
  });
});

describe("Stage 4 の差し戻し文（content）と差し戻し理由の対応", () => {
  it("理由ごとに院長の差し戻し文が1つずつある（過不足なし）", () => {
    expect(Object.keys(stage4ActionRejects).sort()).toEqual(
      [...STAGE4_ACTION_REJECT_REASONS].sort(),
    );
  });

  it("理由ごとに文言が違う（同じ文言を返し続けない）", () => {
    const texts = Object.values(stage4ActionRejects);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it.each(STAGE4_ACTION_REJECT_REASONS)(
    "差し戻し文 %s をそのまま行動提案へ貼っても通らない",
    (reason) => {
      expect(judgeStage4Action(stage4ActionRejects[reason]).outcome).toBe("reject");
    },
  );
});

describe("Stage 4 の判定: Pure Function", () => {
  it("同じ入力には何度呼んでも同じ結果を返す（正規表現の状態を持ち越さない）", () => {
    expect([judgeStage4Summary(summaryOk), judgeStage4Summary(summaryOk)]).toEqual([
      { outcome: "accepted" },
      { outcome: "accepted" },
    ]);
    expect([judgeStage4Action(actionOk), judgeStage4Action(actionOk)]).toEqual([
      { outcome: "pass" },
      { outcome: "pass" },
    ]);
  });
});
