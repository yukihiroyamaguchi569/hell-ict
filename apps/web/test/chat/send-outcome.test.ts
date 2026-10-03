import { chatSendNotices } from "@hell-ict/content";
import { CHAT_MESSAGE_MAX_CHARS, chatMessageResultSchema } from "@hell-ict/domain";
import type { ChatMessageResult, HttpError } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import type { ApiResult } from "../../src/api/http.js";
import {
  chatNoticeText,
  chatSendFollowUp,
  classifyChatSend,
  classifyDraftSend,
} from "../../src/chat/send-outcome.js";
import type { ChatSendOutcome } from "../../src/chat/send-outcome.js";
import { chatMessageBody, chatSnapshotBody } from "../fakes.js";

const THREAD = "11111111-1111-4111-8111-111111111111";

const reply: ChatMessageResult = chatMessageResultSchema.parse({
  snapshot: chatSnapshotBody(2, { [THREAD]: [chatMessageBody(1, "user", "質問")] }),
  assistant: chatMessageBody(2, "assistant", "回答"),
});

const httpError = (
  status: number,
  error: HttpError | null = null,
  retryAfterSeconds: number | null = null,
): ApiResult<ChatMessageResult> => ({ kind: "http-error", status, error, retryAfterSeconds });

const withCode = (status: number, code: HttpError["code"], message = "サーバの文言") =>
  httpError(status, { message, code });

const SENT = "質問";

describe("classifyChatSend の 400（送った本文で見分ける）", () => {
  it.each<[string, string, "too-long" | "invalid"]>([
    ["上限を1字超える", "あ".repeat(CHAT_MESSAGE_MAX_CHARS + 1), "too-long"],
    ["大きく超える", "あ".repeat(CHAT_MESSAGE_MAX_CHARS * 2), "too-long"],
    ["上限ちょうど（長さ以外の理由）", "あ".repeat(CHAT_MESSAGE_MAX_CHARS), "invalid"],
    // Worker は前後の空白を落としてから数える。
    ["前後の空白を除けば上限内", ` ${"あ".repeat(CHAT_MESSAGE_MAX_CHARS)} `, "invalid"],
    ["空白だけ", "   \n\t ", "invalid"],
    ["空", "", "invalid"],
  ])("%s → %s（何も保存されていない）", (_label, text, reason) => {
    expect(classifyChatSend(httpError(400), text)).toEqual({ kind: "unsaved", reason });
  });

  it("本文の code によらず本文で見分ける", () => {
    expect(classifyChatSend(withCode(400, "pii_blocked"), "  ")).toEqual({
      kind: "unsaved",
      reason: "invalid",
    });
  });

  it("空白だけの本文に「長すぎる」とは言わない", () => {
    expect(chatNoticeText(classifyChatSend(httpError(400), "   "))).toBe(chatSendNotices.invalid);
    expect(chatNoticeText(classifyChatSend(httpError(400), "   "))).not.toBe(
      chatSendNotices.tooLong,
    );
  });
});

describe("classifyChatSend", () => {
  it("200 は ok で、応答をそのまま持つ", () => {
    expect(classifyChatSend({ kind: "ok", value: reply }, SENT)).toEqual({
      kind: "ok",
      result: reply,
    });
  });

  it.each<[string, ApiResult<ChatMessageResult>, ChatSendOutcome]>([
    ["422 pii_blocked", withCode(422, "pii_blocked"), { kind: "unsaved", reason: "pii-blocked" }],
    ["409 conflict", withCode(409, "conflict"), { kind: "unsaved", reason: "conflict" }],
    [
      "422 history_pii",
      withCode(422, "history_pii", "会話履歴に個人情報を検知したため、送信をブロックしました。"),
      {
        kind: "saved-retry",
        reason: "refused",
        message: "会話履歴に個人情報を検知したため、送信をブロックしました。",
      },
    ],
    [
      "422 ai_refusal",
      withCode(422, "ai_refusal", "AIが回答を拒否しました: 拒否"),
      { kind: "saved-retry", reason: "refused", message: "AIが回答を拒否しました: 拒否" },
    ],
    [
      "422 で code が無い（古いサーバ）は保存済みに倒す",
      httpError(422, { message: "拒否" }),
      { kind: "saved-retry", reason: "refused", message: "拒否" },
    ],
    [
      "422 で本文が読めない",
      httpError(422),
      { kind: "saved-retry", reason: "refused", message: null },
    ],
    [
      "409 処理中（code なし）",
      httpError(409, { message: "同じ内容が既に送信処理中です。" }),
      { kind: "saved-retry", reason: "in-progress", message: null },
    ],
    [
      "409 で本文が読めない",
      httpError(409),
      { kind: "saved-retry", reason: "in-progress", message: null },
    ],
    [
      "409 で別の code（チェックポイントの拒否）",
      withCode(409, "draft_rejected"),
      { kind: "saved-retry", reason: "in-progress", message: null },
    ],
    ["409 no_ai_chat", withCode(409, "no_ai_chat"), { kind: "stage-moved" }],
    ["409 thread_not_ready", withCode(409, "thread_not_ready"), { kind: "stage-moved" }],
    ["409 stale-generation", withCode(409, "stale-generation"), { kind: "stale" }],
    [
      "429 と Retry-After",
      httpError(429, { message: "送信が多すぎます。" }, 30),
      { kind: "rate-limited", retryAfterSeconds: 30 },
    ],
    [
      "429 で Retry-After が無い",
      httpError(429),
      { kind: "rate-limited", retryAfterSeconds: null },
    ],
    [
      "503",
      httpError(503, { message: "AI応答の取得に失敗しました。" }),
      { kind: "saved-retry", reason: "unavailable", message: null },
    ],
    [
      "500 など想定外のステータス",
      httpError(500),
      { kind: "saved-retry", reason: "unavailable", message: null },
    ],
    [
      "404（チームが無い）",
      httpError(404),
      { kind: "saved-retry", reason: "unavailable", message: null },
    ],
    [
      "通信断・タイムアウト",
      { kind: "network-error" },
      { kind: "saved-retry", reason: "unavailable", message: null },
    ],
    [
      "200 だが形が違う",
      { kind: "invalid-response" },
      { kind: "saved-retry", reason: "unavailable", message: null },
    ],
  ])("%s", (_label, result, outcome) => {
    expect(classifyChatSend(result, SENT)).toEqual(outcome);
  });
});

describe("chatSendFollowUp", () => {
  it.each<[ChatSendOutcome, boolean, "game" | "chat" | null]>([
    [{ kind: "ok", result: reply }, false, null],
    [{ kind: "unsaved", reason: "too-long" }, false, null],
    [{ kind: "unsaved", reason: "invalid" }, false, null],
    [{ kind: "unsaved", reason: "conflict" }, false, null],
    // Stage 5 ではサーバが罠を確定しているので、罰の状態を読み直す。
    [{ kind: "unsaved", reason: "pii-blocked" }, false, "game"],
    [{ kind: "saved-retry", reason: "refused", message: "x" }, true, "chat"],
    [{ kind: "saved-retry", reason: "in-progress", message: null }, true, "chat"],
    [{ kind: "saved-retry", reason: "unavailable", message: null }, true, "chat"],
    [{ kind: "rate-limited", retryAfterSeconds: 5 }, true, null],
    [{ kind: "stage-moved" }, false, "game"],
    [{ kind: "stale" }, true, null],
  ])("%j → IDを残す %s・取り直し %s", (outcome, keepCommandId, refetch) => {
    expect(chatSendFollowUp(outcome)).toEqual({ keepCommandId, refetch });
  });
});

describe("chatNoticeText", () => {
  it.each<[ChatSendOutcome, string | null]>([
    [{ kind: "ok", result: reply }, null],
    [{ kind: "stage-moved" }, null],
    [{ kind: "stale" }, null],
    [{ kind: "unsaved", reason: "too-long" }, chatSendNotices.tooLong],
    [{ kind: "unsaved", reason: "invalid" }, chatSendNotices.invalid],
    [{ kind: "unsaved", reason: "pii-blocked" }, chatSendNotices.piiBlocked],
    [{ kind: "unsaved", reason: "conflict" }, chatSendNotices.inProgress],
    [{ kind: "saved-retry", reason: "refused", message: "サーバの文言" }, "サーバの文言"],
    [{ kind: "saved-retry", reason: "refused", message: null }, chatSendNotices.refused],
    [{ kind: "saved-retry", reason: "in-progress", message: null }, chatSendNotices.inProgress],
    [{ kind: "saved-retry", reason: "unavailable", message: null }, chatSendNotices.unavailable],
    [
      { kind: "rate-limited", retryAfterSeconds: 12 },
      "送信が多すぎます。12 秒待ってからもう一度送ってください。",
    ],
    [
      { kind: "rate-limited", retryAfterSeconds: null },
      "送信が多すぎます。少し待ってからもう一度送ってください。",
    ],
  ])("%j → %s", (outcome, text) => {
    expect(chatNoticeText(outcome)).toBe(text);
  });

  it("分類から文言まで通すと、429 の秒数が文言に出る", () => {
    expect(chatNoticeText(classifyChatSend(httpError(429, null, 3), SENT))).toBe(
      "送信が多すぎます。3 秒待ってからもう一度送ってください。",
    );
  });
});

describe("classifyDraftSend（Stage 1 の下書き）", () => {
  it("409 draft_rejected は理由と Worker の文言つきの draft-rejected", () => {
    const result = httpError(409, {
      message: "要点か、コンテキストが必要です。",
      code: "draft_rejected",
      reason: "no-material",
    });
    expect(classifyDraftSend(result, "")).toEqual({
      kind: "draft-rejected",
      reason: "no-material",
      message: "要点か、コンテキストが必要です。",
    });
  });

  it("理由が無くても draft-rejected", () => {
    expect(classifyDraftSend(withCode(409, "draft_rejected"), "")).toEqual({
      kind: "draft-rejected",
      reason: null,
      message: "サーバの文言",
    });
  });

  it.each<[string, ApiResult<ChatMessageResult>]>([
    ["成功", { kind: "ok", value: reply }],
    ["409 のほかの code", withCode(409, "thread_not_ready")],
    ["422 の draft_rejected（409 以外）", withCode(422, "draft_rejected")],
    ["通信断", { kind: "network-error" }],
  ])("%s はチャットの送信と同じ分類", (_label, result) => {
    expect(classifyDraftSend(result, SENT)).toEqual(classifyChatSend(result, SENT));
  });
});
