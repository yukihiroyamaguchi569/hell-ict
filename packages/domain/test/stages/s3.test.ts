import { stage3Rules } from "@hell-ict/content";
import { stage3Answers } from "@hell-ict/content/answers";
import { describe, expect, it } from "vitest";

import { stageJudgementSchema } from "../../src/schemas/game.js";
import { judgeStage3, STAGE3_FIELD_IDS, stage3SubmissionSchema } from "../../src/stages/s3.js";
import type { Stage3Submission } from "../../src/stages/s3.js";

/*
 * The judge's order and per-field behaviour, through the scenario's answers and rules, so they
 * hold for any scenario. The real scenario's word table is tested in the private hell-ict-scenario repo.
 */

const { ok, trap, negatedTrap, fabricatedCitation } = stage3Answers;

const submission = (fields: Partial<Stage3Submission>): Stage3Submission => ({ ...ok, ...fields });

const EMPTY: Stage3Submission = { ppe: "", release: "", clean: "" };

const FULL_WIDTH_SPACE = String.fromCharCode(0x3000);

describe("judgeStage3: 罠は「罠語あり かつ 正解語なし」", () => {
  it.each(STAGE3_FIELD_IDS)("欄 %s の罠文は罠語を持ち、打ち消しの語を持たない", (field) => {
    const { words, unless } = stage3Rules.traps[field];
    expect(words.test(trap[field])).toBe(true);
    expect(unless.test(trap[field])).toBe(false);
    expect(judgeStage3(submission({ [field]: trap[field] }))).toEqual({ outcome: "trap", field });
  });

  it.each(STAGE3_FIELD_IDS)(
    "欄 %s の打ち消し文は罠語と打ち消しの語の両方を持ち、罠でない",
    (field) => {
      const { words, unless } = stage3Rules.traps[field];
      expect(words.test(negatedTrap[field])).toBe(true);
      expect(unless.test(negatedTrap[field])).toBe(true);
      expect(judgeStage3(submission({ [field]: negatedTrap[field] })).outcome).not.toBe("trap");
    },
  );

  it.each(STAGE3_FIELD_IDS)("欄 %s の罠文に打ち消し文を足すと罠でなくなる", (field) => {
    const text = `${trap[field]}${negatedTrap[field]}`;
    expect(judgeStage3(submission({ [field]: text }))).toEqual({ outcome: "pass" });
  });

  it("他の欄が正解でも、罠のある欄は罠（打ち消しは欄ごと）", () => {
    expect(judgeStage3(submission({ ppe: trap.ppe }))).toEqual({ outcome: "trap", field: "ppe" });
  });
});

describe("judgeStage3: 判定の順序", () => {
  it("捏造出典は正解に添えても罠", () => {
    const input = submission({ release: `${ok.release}${fabricatedCitation}` });
    expect(judgeStage3(input)).toEqual({ outcome: "trap", field: "release" });
  });

  it("捏造出典は上の欄の罠語より先に拾う（PPE欄の罠より clean 欄の出典が勝つ）", () => {
    const input = submission({ ppe: trap.ppe, clean: `${ok.clean}${fabricatedCitation}` });
    expect(judgeStage3(input)).toEqual({ outcome: "trap", field: "clean" });
  });

  it("捏造出典が複数欄にあれば画面順で最初の欄を指す", () => {
    const input = submission({ release: fabricatedCitation, clean: fabricatedCitation });
    expect(judgeStage3(input)).toEqual({ outcome: "trap", field: "release" });
  });

  it("罠は不足より先に見る（PPE欄が空でも解除欄の罠を指す）", () => {
    const input = submission({ ppe: "", release: trap.release });
    expect(judgeStage3(input)).toEqual({ outcome: "trap", field: "release" });
  });

  it("罠が複数欄にあれば画面順で最初の欄を指す", () => {
    const input = submission({ release: trap.release, clean: trap.clean });
    expect(judgeStage3(input)).toEqual({ outcome: "trap", field: "release" });
  });

  it("3欄とも空なら最初の欄の不足", () => {
    expect(judgeStage3(EMPTY)).toEqual({ outcome: "reject", field: "ppe" });
  });

  it.each(STAGE3_FIELD_IDS)("欄 %s だけが空なら、その欄の不足", (field) => {
    expect(judgeStage3(submission({ [field]: "" }))).toEqual({ outcome: "reject", field });
  });

  it.each(STAGE3_FIELD_IDS)(
    "欄 %s は必要語が一部だけなら不足（全部そろって初めて足りる）",
    (field) => {
      expect(judgeStage3(submission({ [field]: stage3Answers.partial[field] }))).toEqual({
        outcome: "reject",
        field,
      });
    },
  );

  it("空白だけの欄は空と同じ", () => {
    expect(judgeStage3(submission({ ppe: ` ${FULL_WIDTH_SPACE}\n` }))).toEqual({
      outcome: "reject",
      field: "ppe",
    });
  });

  it("不足が複数欄にあれば画面順で最初の欄を指す", () => {
    expect(judgeStage3(submission({ release: "", clean: "" }))).toEqual({
      outcome: "reject",
      field: "release",
    });
  });

  it("前後の空白・改行は判定に影響しない", () => {
    const input = submission({
      ppe: `\n  ${ok.ppe}\n\n`,
      clean: `${FULL_WIDTH_SPACE}${ok.clean}${FULL_WIDTH_SPACE}`,
    });
    expect(judgeStage3(input)).toEqual({ outcome: "pass" });
  });
});

describe("judgeStage3: Pure Function", () => {
  it("同じ入力には何度呼んでも同じ結果を返し、入力を書き換えない", () => {
    const input = submission({ release: trap.release });
    const before = structuredClone(input);
    const first = judgeStage3(input);
    expect(judgeStage3(input)).toEqual(first);
    expect(input).toEqual(before);
  });

  it("正規表現の状態を持ち越さない（連続で同じ合格を返す）", () => {
    const input = { ...ok };
    expect([judgeStage3(input), judgeStage3(input), judgeStage3(input)]).toEqual([
      { outcome: "pass" },
      { outcome: "pass" },
      { outcome: "pass" },
    ]);
  });

  it("状態機械へ渡す StageJudgement は outcome だけで schema を満たす", () => {
    for (const input of [ok, EMPTY, submission({ ppe: trap.ppe })]) {
      const { outcome } = judgeStage3(input);
      expect(stageJudgementSchema.safeParse({ outcome }).success).toBe(true);
    }
  });
});

describe("stage3SubmissionSchema: 提出の形", () => {
  it("欄の並びは画面順（PPE→解除→環境）", () => {
    expect(STAGE3_FIELD_IDS).toEqual(["ppe", "release", "clean"]);
  });

  it("3欄の文字列を受け付ける（空文字も可）", () => {
    const parsed = stage3SubmissionSchema.parse({ clean: "", ppe: "", release: "" });
    expect(parsed).toEqual({ ppe: "", release: "", clean: "" });
  });

  it.each([
    ["欄が欠けている", { ppe: "", release: "" }],
    ["文字列でない", { ppe: 1, release: "", clean: "" }],
    ["null", { ppe: null, release: "", clean: "" }],
    ["知らない欄がある", { ppe: "", release: "", clean: "", note: "" }],
    ["オブジェクトでない", "ppe"],
  ])("%sなら拒否する", (_label, value) => {
    expect(stage3SubmissionSchema.safeParse(value).success).toBe(false);
  });
});
