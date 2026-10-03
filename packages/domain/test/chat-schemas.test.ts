import { describe, expect, it } from "vitest";

import {
  chatCommandSchema,
  chatMessageSchema,
  chatSnapshotSchema,
  chatThreadSchema,
} from "../src/schemas/chat.js";

const threadId = "00000000-0000-4000-8000-000000000001";
const messageId = "00000000-0000-4000-8000-000000000010";
const commandId = "00000000-0000-4000-8000-000000000020";

const validMessage = {
  messageId,
  role: "user",
  text: "こんにちは",
  createdAt: "2026-08-20T00:00:00.000Z",
};

describe("チャットschemaの境界", () => {
  it("正当なメッセージを受理し、空文字・4000字超・未知roleを拒否する", () => {
    expect(chatMessageSchema.parse(validMessage)).toEqual(validMessage);
    for (const input of [
      { ...validMessage, text: "" },
      { ...validMessage, text: "  " },
      { ...validMessage, text: "あ".repeat(4001) },
      { ...validMessage, role: "system" },
      { ...validMessage, createdAt: "not-a-date" },
      { ...validMessage, extra: true },
    ]) {
      expect(chatMessageSchema.safeParse(input).success).toBe(false);
    }
    expect(chatMessageSchema.parse({ ...validMessage, text: "あ".repeat(4000) }).text).toHaveLength(
      4000,
    );
  });

  it("threadは空でないtitleとメッセージ配列を受理する", () => {
    const thread = { threadId, title: "メイン", messages: [validMessage] };
    expect(chatThreadSchema.parse(thread)).toEqual(thread);
    expect(chatThreadSchema.safeParse({ ...thread, title: "" }).success).toBe(false);
    expect(chatThreadSchema.safeParse({ ...thread, title: "あ".repeat(41) }).success).toBe(false);
  });

  it("snapshotは最低1スレッドを要求する", () => {
    const snapshot = {
      teamCode: "000000",
      revision: 0,
      threads: [{ threadId, title: "メイン", messages: [] }],
    };
    expect(chatSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(chatSnapshotSchema.safeParse({ ...snapshot, threads: [] }).success).toBe(false);
  });

  it("snapshotのcommandsは省略でき、3種の状態だけを受理する", () => {
    const base = {
      teamCode: "000000",
      revision: 0,
      threads: [{ threadId, title: "メイン", messages: [] }],
    };
    // 照会しなかった応答にはcommands自体が付かない。
    expect(chatSnapshotSchema.parse(base)).toEqual(base);
    const withCommands = {
      ...base,
      commands: { [commandId]: "processed", [threadId]: "pending", [messageId]: "unknown" },
    };
    expect(chatSnapshotSchema.parse(withCommands)).toEqual(withCommands);
    for (const commands of [
      { [commandId]: "done" }, // 未知の状態値
      { [commandId]: null },
      { "not-a-uuid": "processed" }, // 不正なキー
      [],
    ]) {
      expect(chatSnapshotSchema.safeParse({ ...base, commands }).success).toBe(false);
    }
  });

  it("コマンドはtypeで判別され、未知typeと欠落フィールドを拒否する", () => {
    const createThread = { type: "create-thread", commandId, title: "副" };
    const sendMessage = { type: "send-message", commandId, threadId, text: "本文" };
    // kindを送らない既存クライアントはmanualとして解釈される（既定値）。
    // generationも同じく既定0——リセットを持たない古いクライアントとの後方互換で、
    // 一度もリセットしていないチーム（世代0）ではそのまま通る。
    expect(chatCommandSchema.parse(createThread)).toEqual({
      ...createThread,
      kind: "manual",
      generation: 0,
    });
    expect(chatCommandSchema.parse(sendMessage)).toEqual({ ...sendMessage, generation: 0 });
    for (const input of [
      { type: "delete-thread", commandId, threadId },
      { type: "create-thread", commandId, threadId },
      { type: "create-thread", commandId, title: "" },
      { type: "send-message", commandId, threadId, text: "" },
    ]) {
      expect(chatCommandSchema.safeParse(input).success).toBe(false);
    }
  });

  it("send-messageはpromptProfileを省略でき、既知の値を受理し未知の値を拒否する", () => {
    const base = { type: "send-message", commandId, threadId, text: "本文", generation: 0 };
    expect(chatCommandSchema.parse(base)).toEqual(base);
    for (const promptProfile of ["default", "s1", "s3"] as const) {
      const withProfile = { ...base, promptProfile };
      expect(chatCommandSchema.parse(withProfile)).toEqual(withProfile);
    }
    expect(chatCommandSchema.safeParse({ ...base, promptProfile: "s2" }).success).toBe(false);
  });
});
