import { prologueInboxText, prologueMails } from "@hell-ict/content";
import type { Mail } from "@hell-ict/content";
import {
  INBOX_LIMIT_MS,
  INBOX_MAIL_IDS,
  inboxDeadlineAt,
  inboxMailIdSchema,
  inboxMailStatus,
  remainingMs,
} from "@hell-ict/domain";
import type { InboxMailId, InboxState } from "@hell-ict/domain";

import { countdown } from "../../shell/mission-bar-view.js";
import type { InboxDue, InboxRow } from "../stage-module.js";

/*
 * The Prologue's inbox (mock renderMails for `view === "inbox"`, inboxCenter). Pure: the three
 * mails live only here (#281), so no other stage can list them. Whether a mail is still open is
 * the server's rule (`inboxMailStatus`, grace included) on the server's clock.
 */

export const PROLOGUE_MAILS = {
  p0: prologueMails[0],
  p1: prologueMails[1],
  p2: prologueMails[2],
} as const satisfies Record<InboxMailId, Mail>;

const rowDue = (inbox: InboxState, id: InboxMailId, now: number): InboxDue => {
  const status = inboxMailStatus(inbox, id, now);
  if (status !== "live") {
    const text = status === "sent" ? prologueInboxText.sent : prologueInboxText.missed;
    return { text, ratio: null, hot: false };
  }
  const deadline = inboxDeadlineAt(inbox);
  const { text, hot } = countdown({ at: deadline, label: null, overText: null }, now);
  return { text, ratio: remainingMs(deadline, now) / INBOX_LIMIT_MS, hot };
};

/** The three rows, each with the time left to the shared deadline, or why it is closed. */
export const prologueRows = (inbox: InboxState, now: number): readonly InboxRow[] =>
  INBOX_MAIL_IDS.map((id) => ({
    id,
    from: PROLOGUE_MAILS[id].from,
    subject: PROLOGUE_MAILS[id].subj,
    opens: { kind: "center" },
    due: rowDue(inbox, id, now),
    closed: inboxMailStatus(inbox, id, now) !== "live",
  }));

/** The mail the centre shows: the one open, while it can still be answered. */
export const liveOpenMail = (
  inbox: InboxState | null,
  openId: string | null,
  now: number,
): InboxMailId | null => {
  const id = inboxMailIdSchema.safeParse(openId).data ?? null;
  return inbox === null || id === null || inboxMailStatus(inbox, id, now) !== "live" ? null : id;
};
