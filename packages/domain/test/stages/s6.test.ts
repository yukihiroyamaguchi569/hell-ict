import { stage6JimuMail, stage6Rules, stage6SoudanMail } from "@hell-ict/content";
import { stage6Answers } from "@hell-ict/content/answers";
import { describe, expect, it } from "vitest";

import { recordJudgementCommandSchema } from "../../src/schemas/game.js";
import {
  isS6PromptCopiedFromMail,
  judgeS6Submission,
  S6_MAIL_PARAGRAPHS,
  S6_POSTER_TYPES,
  selectS6PosterType,
} from "../../src/stages/s6.js";
import { toStageJudgement } from "../../src/stages/stage-judgement.js";
import { nextId } from "../game/helpers.js";

/*
 * The candidate choice, the copy check and the requirement flow through the scenario's answers
 * and rules, so they hold for any scenario. The real scenario's words are tested in the private
 * hell-ict-scenario repo.
 */

const { promptOk, promptMissingMask, promptMissingHours, promptByType } = stage6Answers;

/** Both requirements, one instruction each. */
const REQUIRED_OK = [promptMissingHours, promptMissingMask] as const;

/** The copy check's normalization (s6.ts normalizeForCopy). */
const normalizeForCopy = (text: string): string =>
  text.replace(/[\s、。，．,.・…「」『』（）()【】〔〕]/g, "");

const katakanaToHiragana = (text: string): string =>
  text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

describe("selectS6PosterType（候補画像の出し分け）", () => {
  it.each(S6_POSTER_TYPES)("promptByType.%s はその種類を選ぶ", (type) => {
    expect(selectS6PosterType(promptByType[type], null)).toBe(type);
  });

  it("複数のタグがあれば、判定語の並び（stage6Rules.posterTags）で先のものを取る", () => {
    const tagged = stage6Rules.posterTags.map(({ type }) => promptByType[type]);
    const [first, second] = stage6Rules.posterTags;
    expect(selectS6PosterType([...tagged].reverse().join(""), null)).toBe(first?.type);
    expect(selectS6PosterType(tagged.slice(1).reverse().join(""), null)).toBe(second?.type);
  });

  it("タグの無い指示は、直前の候補が無ければ標準案", () => {
    expect(selectS6PosterType(promptByType.default, null)).toBe("default");
    expect(selectS6PosterType("", null)).toBe("default");
  });

  it("候補の種類は4つ（content の候補画像の type と同じ値）", () => {
    expect(S6_POSTER_TYPES).toEqual(["pictogram", "multilingual", "textheavy", "default"]);
  });

  it("タグを持つのは標準案以外の3種で、判定語の並びは3種を1つずつ持つ", () => {
    expect(stage6Rules.posterTags.map(({ type }) => type).sort()).toEqual(
      S6_POSTER_TYPES.filter((type) => type !== "default").sort(),
    );
  });

  it.each(S6_POSTER_TYPES)("タグの無い差分指示は直前の候補（%s）の様式を継ぐ", (previous) => {
    expect(selectS6PosterType(promptMissingHours, previous)).toBe(previous);
  });

  it("タグがあれば直前の様式より優先する", () => {
    expect(selectS6PosterType(promptByType.multilingual, "pictogram")).toBe("multilingual");
  });
});

describe("isS6PromptCopiedFromMail（メールの丸写し）", () => {
  it("丸写しの元は事務長と近藤さんの2通の全段落", () => {
    expect(S6_MAIL_PARAGRAPHS).toEqual([...stage6JimuMail.body, ...stage6SoudanMail.body]);
  });

  it.each(S6_MAIL_PARAGRAPHS.map((paragraph, i) => [i, paragraph]))(
    "メール段落%iは正規化後32文字以上（丸ごと貼れば必ず捕まる長さ）",
    (_i, paragraph) => {
      expect(normalizeForCopy(paragraph).length).toBeGreaterThanOrEqual(32);
    },
  );

  it.each(S6_MAIL_PARAGRAPHS.map((paragraph, i) => [i, paragraph]))(
    "メール段落%iを丸ごと貼れば丸写し",
    (_i, paragraph) => {
      expect(isS6PromptCopiedFromMail(paragraph)).toBe(true);
    },
  );

  it("正規化後32文字の連続一致なら丸写し、31文字なら違う", () => {
    const source = normalizeForCopy(S6_MAIL_PARAGRAPHS[0] ?? "");
    expect(isS6PromptCopiedFromMail(source.slice(0, 32))).toBe(true);
    expect(isS6PromptCopiedFromMail(source.slice(-32))).toBe(true);
    expect(isS6PromptCopiedFromMail(`${source.slice(0, 31)}×${source.slice(32, 64)}`)).toBe(true);
    expect(isS6PromptCopiedFromMail(`${source.slice(0, 31)}×${source.slice(31, 62)}`)).toBe(false);
  });

  it("提出文が正規化後31文字以下なら丸写しとしない", () => {
    const source = normalizeForCopy(S6_MAIL_PARAGRAPHS[1] ?? "");
    expect(isS6PromptCopiedFromMail(source.slice(0, 31))).toBe(false);
  });

  it("改行・空白・句読点・括弧を足したり抜いたりしても丸写しと分かる", () => {
    const paragraph = S6_MAIL_PARAGRAPHS[1] ?? "";
    const reflowed = paragraph.replace(/、/g, "\n").replace(/。/g, "  ").replace(/「|」/g, "【");
    expect(isS6PromptCopiedFromMail(reflowed)).toBe(true);
    expect(isS6PromptCopiedFromMail(`${promptByType.pictogram}。${paragraph}`)).toBe(true);
  });

  it.each([promptOk, promptMissingMask, promptMissingHours, ...Object.values(promptByType), ""])(
    "自分の言葉の指示「%s」は丸写しではない",
    (text) => {
      expect(isS6PromptCopiedFromMail(text)).toBe(false);
    },
  );
});

describe("judgeS6Submission（掲示の提出）", () => {
  it.each(["pictogram", "multilingual"] as const)(
    "%sの候補で、マスクと面会時間を指示していれば合格する",
    (type) => {
      expect(judgeS6Submission(type, REQUIRED_OK)).toEqual({ outcome: "pass" });
    },
  );

  it.each(["textheavy", "default"] as const)("%sの候補は指示が揃っていても差し戻す", (type) => {
    expect(judgeS6Submission(type, REQUIRED_OK)).toEqual({ outcome: "reject", reason: type });
  });

  it("要件は指示の累積で見る（1本に全部書かなくてよい）", () => {
    expect(
      judgeS6Submission("pictogram", [
        promptByType.pictogram,
        promptMissingHours,
        promptMissingMask,
      ]),
    ).toEqual({ outcome: "pass" });
  });

  it("1本の指示に要件が揃っていても合格する", () => {
    expect(judgeS6Submission("pictogram", [promptOk])).toEqual({ outcome: "pass" });
  });

  it("指示が無ければマスクから差し戻す", () => {
    expect(judgeS6Submission("pictogram", [])).toEqual({ outcome: "reject", reason: "mask" });
  });

  it("マスクがあって面会時間が無ければ面会時間で差し戻す", () => {
    expect(judgeS6Submission("pictogram", [promptMissingHours])).toEqual({
      outcome: "reject",
      reason: "visiting-hours",
    });
  });

  it("面会時間があってもマスクが無ければマスクで差し戻す", () => {
    expect(judgeS6Submission("multilingual", [promptMissingMask])).toEqual({
      outcome: "reject",
      reason: "mask",
    });
  });

  describe("ひらがなの正規化（#218）", () => {
    it("指示のカタカナをひらがなで書いても、同じ判定になる", () => {
      const hiragana = REQUIRED_OK.map(katakanaToHiragana);
      expect(judgeS6Submission("pictogram", hiragana)).toEqual({ outcome: "pass" });
      expect(judgeS6Submission("pictogram", [katakanaToHiragana(promptMissingHours)])).toEqual({
        outcome: "reject",
        reason: "visiting-hours",
      });
    });

    it("ひらがなの正規化は累積の判定だけに使い、渡された指示は書き換えない", () => {
      const said = katakanaToHiragana(promptMissingHours);
      const log = [said];
      judgeS6Submission("pictogram", log);
      expect(log).toEqual([said]);
    });
  });

  it("回数の上限は無い（同じ入力は何度でも同じ結果）", () => {
    const log = Array.from({ length: 200 }, (_, i) => `指示${String(i)}`);
    expect(judgeS6Submission("pictogram", log)).toEqual({ outcome: "reject", reason: "mask" });
    expect(judgeS6Submission("pictogram", [...log, ...REQUIRED_OK])).toEqual({ outcome: "pass" });
  });

  it("判定の結果はtoStageJudgementでrecord-judgementへ包める（理由は落ちる）", () => {
    for (const type of S6_POSTER_TYPES) {
      for (const log of [[], REQUIRED_OK]) {
        const judgement = judgeS6Submission(type, log);
        const converted = toStageJudgement(judgement);
        expect(converted).toEqual({ outcome: judgement.outcome });
        const command = {
          type: "record-judgement",
          commandId: nextId(),
          stage: "s6",
          judgement: converted,
        };
        expect(recordJudgementCommandSchema.safeParse(command).success).toBe(true);
      }
    }
  });
});
