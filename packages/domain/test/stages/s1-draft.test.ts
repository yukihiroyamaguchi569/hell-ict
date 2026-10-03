import { stage1MailsRound1, stage1MailsRound2, stage1MailsRound3 } from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import { CHAT_MESSAGE_MAX_CHARS } from "../../src/schemas/chat.js";
import { STAGE1_MAIL_IDS } from "../../src/stages/s1.js";
import { buildStage1DraftText } from "../../src/stages/s1-draft.js";

const HEAD = "次の院内メールへの返信を下書きしてください。\n\n";

const r1 = stage1MailsRound2[0];
const r1Block = `【受信メール】\n差出人: ${r1.from}\n件名: ${r1.subj}\n本文:\n${r1.body.join("\n")}`;

describe("Stage 1: AI への下書き依頼文（モックの s1BuildDraftText）", () => {
  it("要点だけ: 見出し・受信メール・要点の順", () => {
    expect(buildStage1DraftText("r1", { context: "", point: " 総務課へ " }, false)).toBe(
      `${HEAD}${r1Block}\n\n【要点】\n総務課へ`,
    );
  });

  it("要点が空白だけなら要点の段を付けない", () => {
    expect(buildStage1DraftText("r1", { context: "", point: " \n " }, false)).toBe(
      `${HEAD}${r1Block}`,
    );
  });

  it("コンテキストを使わないときは、コンテキスト欄に何があっても入れない", () => {
    const text = buildStage1DraftText("r1", { context: "メモ".repeat(100), point: "x" }, false);
    expect(text).not.toContain("【参考資料】");
    expect(text).not.toContain("メモ");
  });

  it("コンテキスト: 参考資料（前後の空白を除く）を受信メールより前に置く", () => {
    expect(buildStage1DraftText("r1", { context: "  引き継ぎメモ  ", point: "" }, true)).toBe(
      `${HEAD}【参考資料】\n引き継ぎメモ\n\n${r1Block}`,
    );
  });

  it("長すぎるコンテキストは先頭から切り詰め、ちょうど上限に収める。受信メールと要点は削らない", () => {
    const text = buildStage1DraftText("r1", { context: "あ".repeat(10_000), point: "要点" }, true);
    expect(text).toHaveLength(CHAT_MESSAGE_MAX_CHARS);
    expect(text?.endsWith(`${r1Block}\n\n【要点】\n要点`)).toBe(true);
  });

  it("上限に収まるコンテキストは切り詰めない（境界: ちょうど上限）", () => {
    const fixed = `${HEAD}【参考資料】\n\n\n${r1Block}`.length;
    const context = "い".repeat(CHAT_MESSAGE_MAX_CHARS - fixed);
    const text = buildStage1DraftText("r1", { context, point: "" }, true);
    expect(text).toHaveLength(CHAT_MESSAGE_MAX_CHARS);
    expect(text).toContain(context);
  });

  it("Stage 1 のすべてのメールから組み立てられる（content と id が揃っている）", () => {
    const ids = [...stage1MailsRound1, ...stage1MailsRound2, ...stage1MailsRound3].map(
      (mail) => mail.id,
    );
    expect(ids).toEqual([...STAGE1_MAIL_IDS]);
    for (const mailId of STAGE1_MAIL_IDS) {
      expect(buildStage1DraftText(mailId, { context: "", point: "" }, false)).toContain(
        "【受信メール】",
      );
    }
  });
});
