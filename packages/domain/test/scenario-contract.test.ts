import {
  stage1MailsRound1,
  stage1MailsRound2,
  stage1MailsRound3,
  stage2AddendumRows,
  stage2SheetRows,
  stage3ContaminatedText,
  stage3Rules,
  stage5FeverSheetText,
} from "@hell-ict/content";
import {
  stage1Answers,
  stage3Answers,
  stage4Answers,
  stage5Answers,
  stage6Answers,
} from "@hell-ict/content/answers";
import { describe, expect, it } from "vitest";

import { detectPii } from "../src/pii.js";
import { isCurtReply, STAGE1_SCHEDULES } from "../src/stages/s1.js";
import { STAGE2_ADDENDUM_ROW_COUNT, STAGE2_BASE_ROW_COUNT } from "../src/stages/s2.js";
import { normalizeStage2Rows } from "../src/stages/s2-table.js";
import type { Stage2Row } from "../src/stages/s2-table.js";
import { judgeStage3, STAGE3_FIELD_IDS } from "../src/stages/s3.js";
import { judgeStage4Action, judgeStage4Summary } from "../src/stages/s4.js";
import { judgeS5Submission } from "../src/stages/s5.js";
import { judgeS6Submission, S6_POSTER_TYPES, selectS6PosterType } from "../src/stages/s6.js";

/*
 * The contract between a scenario (content's texts, rules and answers) and the judges. It holds
 * for the real scenario and for the public dummy alike, so a scenario that breaks it would make
 * the generic tests, the e2e and the game itself go wrong. Run it after swapping the scenario.
 */

describe("契約: Stage 1", () => {
  it("丁寧な返信の例は、そっけない返信と判定されない", () => {
    expect(isCurtReply(stage1Answers.politeReply)).toBe(false);
  });

  it.each([
    [1, stage1MailsRound1],
    [2, stage1MailsRound2],
    [3, stage1MailsRound3],
  ] as const)("R%i の着弾予定の id は content のメールの id と一致する", (round, mails) => {
    const scheduled = STAGE1_SCHEDULES[round].map((mail) => mail.id);
    expect([...scheduled].sort()).toEqual(mails.map((mail) => mail.id).sort());
  });
});

describe("契約: Stage 2", () => {
  it("配布版のラインリストは、ノイズ行を除くと STAGE2_BASE_ROW_COUNT 行", () => {
    const rows = stage2SheetRows.map((row): Stage2Row => [...row]);
    expect(normalizeStage2Rows(rows)).toHaveLength(STAGE2_BASE_ROW_COUNT);
  });

  it("追加分は STAGE2_ADDENDUM_ROW_COUNT 行", () => {
    expect(stage2AddendumRows).toHaveLength(STAGE2_ADDENDUM_ROW_COUNT);
  });
});

describe("契約: Stage 3", () => {
  const ok = stage3Answers.ok;

  it("正解の3欄は合格する", () => {
    expect(judgeStage3(ok)).toEqual({ outcome: "pass" });
  });

  it.each(STAGE3_FIELD_IDS)("欄 %s の罠文は、その欄の罠になる", (field) => {
    expect(judgeStage3({ ...ok, [field]: stage3Answers.trap[field] })).toEqual({
      outcome: "trap",
      field,
    });
  });

  it.each(STAGE3_FIELD_IDS)(
    "欄 %s の打ち消し文は罠語を含むが、罠にならずその欄を満たす",
    (field) => {
      const text = stage3Answers.negatedTrap[field];
      expect(stage3Rules.traps[field].words.test(text)).toBe(true);
      expect(judgeStage3({ ...ok, [field]: text })).toEqual({ outcome: "pass" });
    },
  );

  it.each(STAGE3_FIELD_IDS)("捏造出典を欄 %s の正解に添えると、その欄の罠になる", (field) => {
    const text = `${ok[field]}${stage3Answers.fabricatedCitation}`;
    expect(judgeStage3({ ...ok, [field]: text })).toEqual({ outcome: "trap", field });
  });

  it("早見表を写した PPE 欄は PPE の罠になる", () => {
    expect(judgeStage3({ ...ok, ppe: stage3Answers.contaminatedPpe })).toEqual({
      outcome: "trap",
      field: "ppe",
    });
  });

  it.each(STAGE3_FIELD_IDS)(
    "欄 %s の罠文は捏造出典を含まない（欄ごとの罠語で罠になる）",
    (field) => {
      expect(stage3Rules.fabricatedSource.test(stage3Answers.trap[field])).toBe(false);
    },
  );

  it.each(STAGE3_FIELD_IDS)(
    "欄 %s の足りない文は、必要語の一部だけを持ち、罠にならずその欄の不足になる",
    (field) => {
      const text = stage3Answers.partial[field];
      const matched = stage3Rules.required[field].map((re) => re.test(text));
      expect(matched).toContain(true);
      expect(matched).toContain(false);
      expect(judgeStage3({ ...ok, [field]: text })).toEqual({ outcome: "reject", field });
    },
  );

  // The trap must fire from the material itself (AGENTS.md), not only from the answers.
  it("汚染教材は捏造出典を持ち、どの欄に貼っても罠になる", () => {
    expect(stage3Rules.fabricatedSource.test(stage3ContaminatedText)).toBe(true);
    for (const field of STAGE3_FIELD_IDS) {
      expect(judgeStage3({ ...ok, [field]: stage3ContaminatedText })).toEqual({
        outcome: "trap",
        field,
      });
    }
  });

  it.each(STAGE3_FIELD_IDS)(
    "汚染教材は出典が無くても、欄 %s の罠語を持ち打ち消しの語を持たない",
    (field) => {
      const { words, unless } = stage3Rules.traps[field];
      expect(words.test(stage3ContaminatedText)).toBe(true);
      expect(unless.test(stage3ContaminatedText)).toBe(false);
    },
  );
});

describe("契約: Stage 4", () => {
  it("要約: 正解は受け付け、先行症状の無い要約は差し戻す", () => {
    expect(judgeStage4Summary(stage4Answers.summaryOk)).toEqual({ outcome: "accepted" });
    expect(judgeStage4Summary(stage4Answers.summaryNg)).toEqual({
      outcome: "reject",
      reason: "no-ocular-symptom",
    });
  });

  it.each([
    ["actionOk", stage4Answers.actionOk, { outcome: "pass" }],
    [
      "actionAimedAtPatients",
      stage4Answers.actionAimedAtPatients,
      { outcome: "reject", reason: "aimed-at-patients" },
    ],
    [
      "actionMissingWhat",
      stage4Answers.actionMissingWhat,
      { outcome: "reject", reason: "missing-what" },
    ],
    [
      "actionMissingWhom",
      stage4Answers.actionMissingWhom,
      { outcome: "reject", reason: "missing-whom" },
    ],
    [
      "actionMissingBoth",
      stage4Answers.actionMissingBoth,
      { outcome: "reject", reason: "missing-both" },
    ],
  ] as const)("行動提案 %s は期待どおりに判定される", (_name, text, expected) => {
    expect(judgeStage4Action(text)).toEqual(expected);
  });
});

describe("契約: Stage 5", () => {
  it("整えた一覧は合格し、個人情報を含まない", () => {
    expect(judgeS5Submission(stage5Answers.cleanList)).toEqual({ outcome: "pass" });
    expect(detectPii(stage5Answers.cleanList)).toBeNull();
  });

  it("未整理の一覧をそのまま出すと差し戻される（整える仕事が残っている）", () => {
    expect(judgeS5Submission(stage5FeverSheetText).outcome).toBe("reject");
  });

  it("患者の氏名と、それを含む依頼は送信前ゲートで止まる", () => {
    expect(detectPii(stage5Answers.piiName)).toBe("患者氏名");
    expect(detectPii(stage5Answers.piiSentence)).toBe("患者氏名");
  });
});

describe("契約: Stage 6", () => {
  const { promptOk, promptMissingMask, promptMissingHours, promptByType } = stage6Answers;

  it("正解の指示は合格できる候補を選び、1本で要件を満たす", () => {
    const type = selectS6PosterType(promptOk, null);
    expect(judgeS6Submission(type, [promptOk])).toEqual({ outcome: "pass" });
  });

  it.each(S6_POSTER_TYPES)("promptByType.%s はその種類の候補を選ぶ", (type) => {
    expect(selectS6PosterType(promptByType[type], null)).toBe(type);
  });

  it.each(S6_POSTER_TYPES)("promptByType.%s は要件を1つも満たさない", (type) => {
    expect(judgeS6Submission("pictogram", [promptByType[type]])).toEqual({
      outcome: "reject",
      reason: "mask",
    });
    expect(judgeS6Submission("pictogram", [promptByType[type], promptMissingHours])).toEqual({
      outcome: "reject",
      reason: "visiting-hours",
    });
  });

  it("要件の片方が無い指示は、タグを持たず直前の候補を継ぎ、欠けた要件で差し戻される", () => {
    expect(selectS6PosterType(promptMissingMask, "pictogram")).toBe("pictogram");
    expect(selectS6PosterType(promptMissingHours, "pictogram")).toBe("pictogram");
    expect(selectS6PosterType(promptMissingMask, null)).toBe("default");
    expect(selectS6PosterType(promptMissingHours, null)).toBe("default");
    expect(judgeS6Submission("pictogram", [promptMissingMask])).toEqual({
      outcome: "reject",
      reason: "mask",
    });
    expect(judgeS6Submission("pictogram", [promptMissingHours])).toEqual({
      outcome: "reject",
      reason: "visiting-hours",
    });
    expect(judgeS6Submission("pictogram", [promptMissingMask, promptMissingHours])).toEqual({
      outcome: "pass",
    });
  });
});
