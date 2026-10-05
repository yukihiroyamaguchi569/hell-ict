import { chatMessageResultSchema, sendMessageCommandSchema } from "@hell-ict/domain";
import type { PromptProfile, SendMessageCommand } from "@hell-ict/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLAIM_TIMEOUT_MS,
  isClaimStale,
  mismatchesPending,
  replayProcessed,
} from "../src/chat-ledger.js";
import type { StoredPendingMessage } from "../src/chat-ledger.js";

const THREAD_A = "00000000-0000-4000-8000-00000000c001";
const THREAD_B = "00000000-0000-4000-8000-00000000c002";
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

const command = (threadId: string, promptProfile?: PromptProfile): SendMessageCommand =>
  sendMessageCommandSchema.parse({
    type: "send-message",
    commandId: "00000000-0000-4000-8000-00000000c010",
    threadId,
    text: "本文",
    promptProfile,
    generation: 0,
  });

const pending = (overrides: Partial<StoredPendingMessage>): StoredPendingMessage => ({
  thread_id: THREAD_A,
  claimed_at: null,
  prompt_profile: null,
  fingerprint: null,
  claim_generation: 1,
  ...overrides,
});

describe("mismatchesPending（pending行と再送の照合）", () => {
  it("指紋がある行は指紋だけで照合し、threadIdの違いは見ない", () => {
    const row = pending({ fingerprint: FINGERPRINT_A, thread_id: THREAD_B });

    expect(mismatchesPending(row, command(THREAD_A), FINGERPRINT_A)).toBe(false);
    expect(mismatchesPending(row, command(THREAD_A), FINGERPRINT_B)).toBe(true);
  });

  it("指紋の無い旧行は、threadIdが同じでprofileも一致すれば同じ送信とみなす", () => {
    const row = pending({ prompt_profile: "default" });

    expect(mismatchesPending(row, command(THREAD_A), FINGERPRINT_A)).toBe(false);
  });

  it("指紋の無い旧行は、threadIdが違えば取り違えとする", () => {
    expect(mismatchesPending(pending({}), command(THREAD_B), FINGERPRINT_A)).toBe(true);
  });

  it("指紋の無い旧行は、profileが違えば取り違えとする（未指定はdefault扱い）", () => {
    const row = pending({ prompt_profile: "default" });
    expect(mismatchesPending(row, command(THREAD_A, "s1"), FINGERPRINT_A)).toBe(true);
  });

  it("profile列がNULLの旧行は、profileの照合をスキップする", () => {
    const row = pending({ prompt_profile: null });
    expect(mismatchesPending(row, command(THREAD_A, "s1"), FINGERPRINT_A)).toBe(false);
  });
});

describe("replayProcessed（processed行からの冪等再送）", () => {
  const assistant = {
    messageId: "00000000-0000-4000-8000-00000000c020",
    role: "assistant",
    text: "応答",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const result = chatMessageResultSchema.parse({
    snapshot: {
      teamCode: "400100",
      revision: 1,
      threads: [{ threadId: THREAD_A, title: "メイン", messages: [assistant] }],
    },
    assistant,
  });

  it("指紋が一致すれば元の結果を返す", () => {
    expect(replayProcessed({ result, fingerprint: FINGERPRINT_A }, FINGERPRINT_A)).toEqual({
      kind: "already-processed",
      result,
    });
  });

  it("指紋が違えばconflictにし、元の結果を返さない", () => {
    expect(replayProcessed({ result, fingerprint: FINGERPRINT_A }, FINGERPRINT_B)).toEqual({
      kind: "conflict",
    });
  });

  it("指紋の無い旧行は照合をスキップし、元の結果を返す", () => {
    expect(replayProcessed({ result, fingerprint: null }, FINGERPRINT_B)).toEqual({
      kind: "already-processed",
      result,
    });
  });
});

describe("isClaimStale（クレームを取り直してよいか）", () => {
  const nowMs = Date.parse("2026-10-06T00:00:00.000Z");
  const claimedAgo = (ms: number): string => new Date(nowMs - ms).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("クレームが無ければ取り直してよい", () => {
    expect(isClaimStale(null)).toBe(true);
  });

  it("ちょうど閾値の経過では、まだ処理中とみなす", () => {
    expect(isClaimStale(claimedAgo(CLAIM_TIMEOUT_MS))).toBe(false);
  });

  it("閾値を1ミリ秒でも超えれば取り直してよい", () => {
    expect(isClaimStale(claimedAgo(CLAIM_TIMEOUT_MS + 1))).toBe(true);
  });

  it("取ったばかりのクレームは処理中とみなす", () => {
    expect(isClaimStale(claimedAgo(0))).toBe(false);
  });
});
