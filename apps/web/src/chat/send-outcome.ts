import { chatSendNotices, rateLimitNotice } from "@hell-ict/content";
import { CHAT_MESSAGE_MAX_CHARS } from "@hell-ict/domain";
import type { ChatMessageResult } from "@hell-ict/domain";

import type { ApiResult } from "../api/http.js";

/**
 * What one `POST .../game/chat/messages` came to, as the chat pane acts on it (the mock's
 * sendAiLive, isUnsavedRejection and handleLiveChatError). No send is ever resent by itself: the
 * participant presses again, and the same text then goes with the same commandId unless the
 * outcome dropped it.
 * - ok: the reply. The id is settled.
 * - unsaved: refused before anything was stored (400 too long or blank, 422 pii_blocked, 409
 *   conflict).
 *   The id is dropped. After pii_blocked the game is fetched again: in Stage 5 the server has
 *   already sprung the trap.
 * - saved-retry: the message may be stored without a reply (422 history_pii / ai_refusal, 409 in
 *   progress, 503, no answer, an answer the screen cannot read). The id is kept, and the chat is
 *   fetched again to show what the server has.
 * - rate-limited: 429. The id is kept; `retryAfterSeconds` is told, nothing waits for it.
 * - stage-moved: the stage has no AI to send to, or its conversation is not ready (409
 *   no_ai_chat / thread_not_ready). Nothing was stored; the game is fetched again.
 * - stale: the game master reset the team (409 stale-generation). The screen asks for a reload.
 */
export type ChatSendOutcome =
  | { readonly kind: "ok"; readonly result: ChatMessageResult }
  | {
      readonly kind: "unsaved";
      readonly reason: "too-long" | "invalid" | "pii-blocked" | "conflict";
    }
  | {
      readonly kind: "saved-retry";
      readonly reason: "refused" | "in-progress" | "unavailable";
      /** The Worker's own words for a refusal (422), when it sent them. */
      readonly message: string | null;
    }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "stage-moved" }
  | { readonly kind: "stale" };

type HttpErrorResult = Extract<ApiResult<unknown>, { kind: "http-error" }>;

const UNAVAILABLE: ChatSendOutcome = { kind: "saved-retry", reason: "unavailable", message: null };

/**
 * 422 carries its kind in `code`. One without a readable code (an older server) counts as
 * stored: keeping an id the server never saw is harmless, dropping one it saved stores the
 * message twice.
 */
const classify422 = (error: HttpErrorResult["error"]): ChatSendOutcome =>
  error?.code === "pii_blocked"
    ? { kind: "unsaved", reason: "pii-blocked" }
    : { kind: "saved-retry", reason: "refused", message: error?.message ?? null };

const classify409 = (error: HttpErrorResult["error"]): ChatSendOutcome => {
  switch (error?.code) {
    case "stale-generation":
      return { kind: "stale" };
    case "no_ai_chat":
    case "thread_not_ready":
      return { kind: "stage-moved" };
    // The same id with another body: that id can never go through. A fresh one can.
    case "conflict":
      return { kind: "unsaved", reason: "conflict" };
    default:
      return { kind: "saved-retry", reason: "in-progress", message: null };
  }
};

/**
 * The ids and the thread are the screen's own, so a 400 is about the text: too long, or blank
 * (the Worker trims it first, then counts). Only the first has the mock's words.
 */
const classify400 = (sentText: string): ChatSendOutcome => ({
  kind: "unsaved",
  reason: sentText.trim().length > CHAT_MESSAGE_MAX_CHARS ? "too-long" : "invalid",
});

const classifyHttpError = (result: HttpErrorResult, sentText: string): ChatSendOutcome => {
  switch (result.status) {
    case 400:
      return classify400(sentText);
    case 409:
      return classify409(result.error);
    case 422:
      return classify422(result.error);
    case 429:
      return { kind: "rate-limited", retryAfterSeconds: result.retryAfterSeconds };
    default:
      return UNAVAILABLE;
  }
};

/**
 * What Stage 1's [AIに下書きさせる] (`type: "s1-draft"` on the same route) came to: a chat send,
 * or `draft-rejected` (409 draft_rejected: the server's gate refused it — the round is over, the
 * mail expired, no material …). Nothing was stored then, so the id is dropped; `reason` is the
 * gate's reason (`judgeStage1DraftRequest`, or `not-started`) and `message` the Worker's words.
 */
export type DraftSendOutcome =
  | ChatSendOutcome
  | { readonly kind: "draft-rejected"; readonly reason: string | null; readonly message: string };

/** `sentText` as for `classifyChatSend` (a draft sends the key points as its text). */
export const classifyDraftSend = (
  result: ApiResult<ChatMessageResult>,
  sentText: string,
): DraftSendOutcome =>
  result.kind === "http-error" && result.status === 409 && result.error?.code === "draft_rejected"
    ? { kind: "draft-rejected", reason: result.error.reason ?? null, message: result.error.message }
    : classifyChatSend(result, sentText);

/** `sentText` is the text that was sent: a 400 is told apart by it. */
export const classifyChatSend = (
  result: ApiResult<ChatMessageResult>,
  sentText: string,
): ChatSendOutcome => {
  if (result.kind === "ok") return { kind: "ok", result: result.value };
  return result.kind === "http-error" ? classifyHttpError(result, sentText) : UNAVAILABLE;
};

/**
 * What the pane does after an outcome: keep the commandId for the next press of the same text,
 * and which state to fetch again.
 */
export interface ChatSendFollowUp {
  readonly keepCommandId: boolean;
  readonly refetch: "game" | "chat" | null;
}

export const chatSendFollowUp = (outcome: ChatSendOutcome): ChatSendFollowUp => {
  switch (outcome.kind) {
    case "ok":
      return { keepCommandId: false, refetch: null };
    case "unsaved":
      return { keepCommandId: false, refetch: outcome.reason === "pii-blocked" ? "game" : null };
    case "saved-retry":
      return { keepCommandId: true, refetch: "chat" };
    case "rate-limited":
      return { keepCommandId: true, refetch: null };
    case "stage-moved":
      return { keepCommandId: false, refetch: "game" };
    case "stale":
      return { keepCommandId: true, refetch: null };
  }
};

type Reason<K extends ChatSendOutcome["kind"]> =
  Extract<ChatSendOutcome, { kind: K }> extends {
    reason: infer R extends string;
  }
    ? R
    : never;

const UNSAVED_NOTICES: Readonly<Record<Reason<"unsaved">, string>> = {
  "too-long": chatSendNotices.tooLong,
  invalid: chatSendNotices.invalid,
  "pii-blocked": chatSendNotices.piiBlocked,
  // The mock says the same for every 409.
  conflict: chatSendNotices.inProgress,
};

const SAVED_RETRY_NOTICES: Readonly<Record<Reason<"saved-retry">, string>> = {
  refused: chatSendNotices.refused,
  "in-progress": chatSendNotices.inProgress,
  unavailable: chatSendNotices.unavailable,
};

/**
 * The system bubble for an outcome, or `null` when there is none: a reply needs none, a stage
 * that moved shows its own pane, and a stale tab shows the reload notice.
 */
export const chatNoticeText = (outcome: ChatSendOutcome): string | null => {
  switch (outcome.kind) {
    case "ok":
    case "stage-moved":
    case "stale":
      return null;
    case "unsaved":
      return UNSAVED_NOTICES[outcome.reason];
    case "saved-retry":
      // Only a refusal carries the Worker's words.
      return outcome.message ?? SAVED_RETRY_NOTICES[outcome.reason];
    case "rate-limited":
      return rateLimitNotice(outcome.retryAfterSeconds);
  }
};
