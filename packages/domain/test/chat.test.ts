import { describe, expect, it } from "vitest";

import {
  appendMessage,
  chatCommandFingerprint,
  countThreadsOfKind,
  createThread,
  initialChatSnapshot,
} from "../src/chat.js";
import { chatMessageSchema } from "../src/schemas/chat.js";

const mainThreadId = "00000000-0000-4000-8000-000000000001";
const otherThreadId = "00000000-0000-4000-8000-000000000002";

const message = (text: string) =>
  chatMessageSchema.parse({
    messageId: "00000000-0000-4000-8000-000000000010",
    role: "user",
    text,
    createdAt: "2026-08-20T00:00:00.000Z",
  });

describe("チャットスレッドの純粋関数", () => {
  it("メイン1本だけを持つ初期状態を作る", () => {
    const snapshot = initialChatSnapshot("000000", mainThreadId);
    expect(snapshot).toEqual({
      teamCode: "000000",
      revision: 0,
      threads: [{ threadId: mainThreadId, title: "メイン", messages: [] }],
    });
  });

  it("既知スレッドへメッセージを追加し、revisionを進める", () => {
    const snapshot = initialChatSnapshot("000000", mainThreadId);
    const result = appendMessage(snapshot, { threadId: mainThreadId, message: message("test") });
    expect(result).toEqual({
      ok: true,
      snapshot: {
        ...snapshot,
        revision: 1,
        threads: [{ ...snapshot.threads[0], messages: [message("test")] }],
      },
    });
  });

  it("未知スレッドへの追加を拒否し、状態を変えない", () => {
    const snapshot = initialChatSnapshot("000000", mainThreadId);
    const result = appendMessage(snapshot, { threadId: otherThreadId, message: message("test") });
    expect(result).toEqual({ ok: false, reason: "unknown-thread" });
  });

  it("他スレッドの順序を保ったまま、対象スレッドだけへ追加する", () => {
    const base = initialChatSnapshot("000000", mainThreadId);
    const withSecond = createThread(base, { threadId: otherThreadId, title: "副", kind: "manual" });
    if (!withSecond.ok) throw new Error("unexpected");
    const first = appendMessage(withSecond.snapshot, {
      threadId: mainThreadId,
      message: message("先"),
    });
    if (!first.ok) throw new Error("unexpected");
    const second = appendMessage(first.snapshot, {
      threadId: mainThreadId,
      message: message("後"),
    });
    if (!second.ok) throw new Error("unexpected");
    expect(second.snapshot.threads[0]?.messages.map((m) => m.text)).toEqual(["先", "後"]);
    expect(second.snapshot.threads[1]?.messages).toEqual([]);
  });

  it("スレッドを作成し、重複threadIdを拒否する", () => {
    const snapshot = initialChatSnapshot("000000", mainThreadId);
    const created = createThread(snapshot, {
      threadId: otherThreadId,
      title: "副",
      kind: "manual",
    });
    expect(created).toEqual({
      ok: true,
      snapshot: {
        ...snapshot,
        revision: 1,
        threads: [
          ...snapshot.threads,
          { threadId: otherThreadId, title: "副", kind: "manual", messages: [] },
        ],
      },
    });
    if (!created.ok) throw new Error("unexpected");
    expect(
      createThread(created.snapshot, { threadId: mainThreadId, title: "重複", kind: "manual" }),
    ).toEqual({
      ok: false,
      reason: "duplicate-thread",
    });
  });
});

describe("countThreadsOfKind", () => {
  const base = initialChatSnapshot("000000", mainThreadId);

  it("kindを持たない既存スレッドはmanualとして数える", () => {
    // initialChatSnapshotのメインスレッドはkindを持たない。ステージ枠を過去の
    // スレッドで先に埋めさせないため、manual側へ寄せる。
    expect(base.threads[0]?.kind).toBeUndefined();
    expect(countThreadsOfKind(base, "manual")).toBe(1);
    expect(countThreadsOfKind(base, "stage")).toBe(0);
  });

  it("kindごとに独立して数える", () => {
    const withStage = createThread(base, {
      threadId: otherThreadId,
      title: "Stage 1",
      kind: "stage",
    });
    if (!withStage.ok) throw new Error("unexpected");
    expect(countThreadsOfKind(withStage.snapshot, "stage")).toBe(1);
    expect(countThreadsOfKind(withStage.snapshot, "manual")).toBe(1);

    const withManual = createThread(withStage.snapshot, {
      threadId: "00000000-0000-4000-8000-000000000003",
      title: "副",
      kind: "manual",
    });
    if (!withManual.ok) throw new Error("unexpected");
    expect(countThreadsOfKind(withManual.snapshot, "stage")).toBe(1);
    expect(countThreadsOfKind(withManual.snapshot, "manual")).toBe(2);
  });
});

describe("chatCommandFingerprint", () => {
  const base = { threadId: mainThreadId, text: "本文" } as const;

  it("同じ内容は同じ指紋になる（SHA-256の16進64桁）", async () => {
    const first = await chatCommandFingerprint(base);
    const second = await chatCommandFingerprint({ ...base });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("threadId・promptProfile・本文のどれが変わっても指紋が変わる", async () => {
    const original = await chatCommandFingerprint(base);
    expect(await chatCommandFingerprint({ ...base, threadId: otherThreadId })).not.toBe(original);
    expect(await chatCommandFingerprint({ ...base, text: "別の本文" })).not.toBe(original);
    expect(await chatCommandFingerprint({ ...base, promptProfile: "s3" })).not.toBe(original);
  });

  it('promptProfile未指定は"default"と同じ指紋になる', async () => {
    expect(await chatCommandFingerprint(base)).toBe(
      await chatCommandFingerprint({ ...base, promptProfile: "default" }),
    );
  });

  it("フィールドの境界が潰れない", async () => {
    // 区切りに改行を挟むので、隣接フィールドへ文字を移しても同じ指紋にならない。
    const left = await chatCommandFingerprint({ threadId: "ab", text: "c" });
    const right = await chatCommandFingerprint({ threadId: "a", text: "bc" });
    expect(left).not.toBe(right);
  });
});
