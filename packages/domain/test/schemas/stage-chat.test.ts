import { describe, expect, it } from "vitest";

import { CHAT_MESSAGE_MAX_CHARS } from "../../src/schemas/chat.js";
import {
  prepareStageThreadCommandSchema,
  stageAiSchema,
  stageChatCommandSchema,
} from "../../src/schemas/stage-chat.js";

const base = { commandId: crypto.randomUUID(), generation: 0 };

describe("ステージのAIチャットのコマンド", () => {
  it("会話は本文だけを持つ（スレッドもプロンプトも画面は選ばない）", () => {
    const parsed = stageChatCommandSchema.parse({ type: "stage-message", ...base, text: " 質問 " });
    expect(parsed).toEqual({ type: "stage-message", ...base, text: "質問" });
  });

  it.each([
    ["threadId を送る", { threadId: crypto.randomUUID() }],
    ["promptProfile を送る", { promptProfile: "s3" }],
    ["空白だけの本文", { text: "   " }],
    ["上限を超える本文", { text: "あ".repeat(CHAT_MESSAGE_MAX_CHARS + 1) }],
  ])("%s 会話は拒否する", (_name, patch) => {
    expect(
      stageChatCommandSchema.safeParse({ type: "stage-message", ...base, text: "質問", ...patch })
        .success,
    ).toBe(false);
  });

  it("上限ちょうどの本文は通す", () => {
    expect(
      stageChatCommandSchema.safeParse({
        type: "stage-message",
        ...base,
        text: "あ".repeat(CHAT_MESSAGE_MAX_CHARS),
      }).success,
    ).toBe(true);
  });

  it("下書きはメールID・コンテキスト・要点を持つ（空でもよい。判定はサーバが行う）", () => {
    const draft = { type: "s1-draft", ...base, mailId: "r1", context: "", point: "" };
    expect(stageChatCommandSchema.parse(draft)).toEqual(draft);
  });

  it.each([
    ["未知のメール", { mailId: "x9" }],
    ["本文を送る", { text: "下書きして" }],
    ["長すぎるコンテキスト", { context: "あ".repeat(8_001) }],
    ["長すぎる要点", { point: "あ".repeat(CHAT_MESSAGE_MAX_CHARS + 1) }],
  ])("%s 下書きは拒否する", (_name, patch) => {
    expect(
      stageChatCommandSchema.safeParse({
        type: "s1-draft",
        ...base,
        mailId: "r1",
        context: "",
        point: "",
        ...patch,
      }).success,
    ).toBe(false);
  });

  it("コンテキストは8,000字まで", () => {
    expect(
      stageChatCommandSchema.safeParse({
        type: "s1-draft",
        ...base,
        mailId: "r1",
        context: "あ".repeat(8_000),
        point: "",
      }).success,
    ).toBe(true);
  });

  it("会話の準備のやり直しは世代だけを持つ", () => {
    expect(
      prepareStageThreadCommandSchema.parse({ type: "prepare-stage-thread", generation: 2 }),
    ).toEqual({ type: "prepare-stage-thread", generation: 2 });
    expect(
      prepareStageThreadCommandSchema.safeParse({ type: "prepare-stage-thread", generation: -1 })
        .success,
    ).toBe(false);
  });
});

describe("GETに載るステージのAI", () => {
  it("ready はスレッドIDとAIへ送るかを持つ。none と failed は何も持たない", () => {
    const threadId = crypto.randomUUID();
    expect(stageAiSchema.parse({ status: "ready", threadId, live: true })).toEqual({
      status: "ready",
      threadId,
      live: true,
    });
    expect(stageAiSchema.safeParse({ status: "failed", threadId }).success).toBe(false);
    expect(stageAiSchema.safeParse({ status: "ready", live: true }).success).toBe(false);
  });
});
