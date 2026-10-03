import { z } from "zod";

import type { StageJudgement } from "../schemas/game.js";
import { DEADLINE_GRACE_MS, epochMsSchema, isPastDeadline, secondsToMs } from "./deadline.js";

/**
 * Prologue inbox: three mails, each with a reply box. Ported from the mock's `INBOX_LIMIT`,
 * `inboxExpire`, `inboxOpenable`, `inboxSend` and the completion test in `inboxFrame`
 * (hell-ict-archive:docs/ui/mock/index.html).
 * - The text is never judged; only an empty reply is refused.
 * - All three share one deadline, five minutes after the inbox was opened (they all land then).
 * - A mail past the deadline can no longer be answered, and there is no penalty for it.
 * - The Prologue is done once no mail is still open (every mail is sent or missed).
 * The mock's index `i` into `MAILS` is the id `p<i>`, the same key as the mock's `VIEWERS`.
 */
export const INBOX_MAIL_IDS = ["p0", "p1", "p2"] as const;

export const inboxMailIdSchema = z.enum(INBOX_MAIL_IDS);

export type InboxMailId = z.infer<typeof inboxMailIdSchema>;

/** The mock's `INBOX_LIMIT` (300 s): the time for every mail, counted from `openedAt`. */
export const INBOX_LIMIT_MS = secondsToMs(300);

/**
 * `openedAt` is the mock's `inboxT0` (an absolute instant, so a reload cannot stretch the
 * deadline). Missed mails are not stored: they follow from `openedAt` and the clock.
 */
export const inboxStateSchema = z
  .object({
    openedAt: epochMsSchema,
    sent: z.array(inboxMailIdSchema),
  })
  .strict()
  .refine((state) => new Set(state.sent).size === state.sent.length, {
    message: "sent has duplicates",
  });

export type InboxState = z.infer<typeof inboxStateSchema>;

export type InboxMailStatus = "live" | "sent" | "missed";

export const startInbox = (now: number): InboxState => ({ openedAt: now, sent: [] });

/**
 * Coming back to the inbox after a reload (the mock's `inboxLoad` + `inboxStartAuto` with the
 * resume flag). A saved state is used only if it parses and was opened no later than `now`;
 * anything else is dropped and the inbox starts over — a start in the future would stretch the
 * deadline, and half a state does more harm than a fresh one.
 */
export const resumeInbox = (saved: unknown, now: number): InboxState => {
  const parsed = inboxStateSchema.safeParse(saved);
  return parsed.success && parsed.data.openedAt <= now ? parsed.data : startInbox(now);
};

/** The nominal deadline shown on screen. The server keeps accepting for the grace period. */
export const inboxDeadlineAt = (state: InboxState): number => state.openedAt + INBOX_LIMIT_MS;

export const inboxMailStatus = (
  state: InboxState,
  mailId: InboxMailId,
  now: number,
): InboxMailStatus => {
  if (state.sent.includes(mailId)) return "sent";
  return isPastDeadline(inboxDeadlineAt(state), now) ? "missed" : "live";
};

/**
 * Why a reply is refused. The mock checks the mail first (`inboxOpenable`), then the text.
 * - already-sent / expired: the mail is no longer open (the mock just redraws the inbox).
 * - empty: nothing but whitespace (the mock's 「本文が空です」 on the button).
 */
export const INBOX_REPLY_REJECT_REASONS = ["already-sent", "expired", "empty"] as const;

export type InboxReplyRejectReason = (typeof INBOX_REPLY_REJECT_REASONS)[number];

/** A reply does not clear anything, so this is deliberately not a `StageJudgement`. */
export type InboxReplyJudgement =
  | { outcome: "accepted" }
  | { outcome: "reject"; reason: InboxReplyRejectReason };

export interface InboxReplyResult {
  state: InboxState;
  judgement: InboxReplyJudgement;
}

const replyBlocker = (
  state: InboxState,
  mailId: InboxMailId,
  text: string,
  now: number,
): InboxReplyRejectReason | null => {
  const status = inboxMailStatus(state, mailId, now);
  if (status === "sent") return "already-sent";
  if (status === "missed") return "expired";
  return text.trim() === "" ? "empty" : null;
};

/** A refused reply leaves the state untouched. */
export const sendInboxReply = (
  state: InboxState,
  mailId: InboxMailId,
  text: string,
  now: number,
): InboxReplyResult => {
  const reason = replyBlocker(state, mailId, text, now);
  if (reason !== null) return { state, judgement: { outcome: "reject", reason } };
  return { state: { ...state, sent: [...state.sent, mailId] }, judgement: { outcome: "accepted" } };
};

export type PrologueJudgement =
  | Extract<StageJudgement, { outcome: "pass" }>
  | (Extract<StageJudgement, { outcome: "reject" }> & { reason: "mails-open" });

/** The mock moves on to Stage 1 once every mail is sent or missed (`inboxFrame`). */
export const judgePrologue = (state: InboxState, now: number): PrologueJudgement =>
  INBOX_MAIL_IDS.every((mailId) => inboxMailStatus(state, mailId, now) !== "live")
    ? { outcome: "pass" }
    : { outcome: "reject", reason: "mails-open" };

/**
 * When the screen sends `inbox.settle` (`GET /game` never judges): the first instant the server
 * counts the unanswered mails as missed (`isPastDeadline`), the nominal deadline plus the grace.
 */
export const inboxSettleAt = (state: InboxState): number =>
  inboxDeadlineAt(state) + DEADLINE_GRACE_MS;
