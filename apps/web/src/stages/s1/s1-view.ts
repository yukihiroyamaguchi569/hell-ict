import {
  stage1MailsRound1,
  stage1MailsRound2,
  stage1MailsRound3,
  stage1Memo,
} from "@hell-ict/content";
import type { Stage1Mail as Stage1MailText } from "@hell-ict/content";
import { stage1Mails, stage1MemoDeadlineAt, stage1MemoStatus } from "@hell-ict/domain";
import type { Stage1MailId, Stage1MailStatus, Stage1State } from "@hell-ict/domain";

/*
 * Stage 1's inbox as the screen draws it (the mock's s1ListRows). Pure: the rows follow from the
 * state and the server's time, so every PC of the team lists the same mails in the same order.
 */

/** The handover memo's row id (it is not one of the round's mails). */
export const STAGE1_MEMO_ROW_ID = "memo";

export type Stage1RowId = Stage1MailId | typeof STAGE1_MEMO_ROW_ID;

export interface Stage1Row {
  readonly id: Stage1RowId;
  readonly from: string;
  readonly subject: string;
  /** The memo: always first, whatever its deadline. */
  readonly pinned: boolean;
  readonly status: Exclude<Stage1MailStatus, "pending">;
  /** The nominal deadline (server epoch ms): the countdown and its bar count down to it. */
  readonly dueAt: number;
}

const MAIL_TEXTS: readonly Stage1MailText[] = [
  ...stage1MailsRound1,
  ...stage1MailsRound2,
  ...stage1MailsRound3,
];

/** The words of a mail (sender, subject, body, the drafts of the scripted AI). */
export const stage1MailText = (id: Stage1MailId): Stage1MailText | null =>
  MAIL_TEXTS.find((mail) => mail.id === id) ?? null;

const memoRow = (state: Stage1State, now: number): Stage1Row => ({
  id: STAGE1_MEMO_ROW_ID,
  from: stage1Memo.from,
  subject: stage1Memo.subj,
  pinned: true,
  status: stage1MemoStatus(state, now),
  dueAt: stage1MemoDeadlineAt(state),
});

/** Live mails first, then by deadline: the list reads top to bottom as the order to answer in. */
const byUrgency = (a: Stage1Row, b: Stage1Row): number =>
  Number(a.status !== "live") - Number(b.status !== "live") || a.dueAt - b.dueAt;

/**
 * The memo, then this round's mails that have landed. A mail done or missed stays in the list
 * (its row says so) and can no longer be opened.
 */
export const stage1Rows = (state: Stage1State, now: number): readonly Stage1Row[] => {
  const mails = stage1Mails(state, now).flatMap((mail): Stage1Row[] => {
    const text = stage1MailText(mail.id);
    if (mail.status === "pending" || text === null) return [];
    const { status, dueAt } = mail;
    return [{ id: mail.id, from: text.from, subject: text.subj, pinned: false, status, dueAt }];
  });
  return [memoRow(state, now), ...mails.sort(byUrgency)];
};

/** Only a live row opens (the mock's onClick: a mail done or missed is closed for good). */
export const stage1CanOpen = (rows: readonly Stage1Row[], id: Stage1RowId): boolean =>
  rows.some((row) => row.id === id && row.status === "live");

/**
 * The mails of this round that have landed by `now`, one key each. The key carries the round's
 * start, so a new try of R3 (the same mails again) lands anew.
 */
export const stage1LandedKeys = (state: Stage1State | null, now: number): readonly string[] =>
  state === null
    ? []
    : stage1Mails(state, now).flatMap((mail) =>
        mail.status === "pending" ? [] : [`${String(state.roundStartedAt)}:${mail.id}`],
      );

/**
 * The landed mails not chimed yet (the mock's s1Land chimes once for each). `heard` is `null`
 * until the screen knows what had landed before it came up (a reload): nothing is new then.
 */
export const stage1NewLandings = (
  heard: ReadonlySet<string> | null,
  after: readonly string[],
): readonly string[] => (heard === null ? [] : after.filter((key) => !heard.has(key)));
