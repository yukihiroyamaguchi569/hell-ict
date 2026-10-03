import { stage1CurtVoices, stage1ResultText, stage1ScreenText } from "@hell-ict/content";
import {
  STAGE1_REPLY_LIMIT_MS,
  stage1AttemptNo,
  stage1Mails,
  stage1MemoDeadlineAt,
  stage1RoundSummary,
} from "@hell-ict/domain";
import type { Stage1State, TeamGameViewState } from "@hell-ict/domain";

import { countdown } from "../../shell/mission-bar-view.js";
import type { MissionDeadline, StageFocus } from "../../shell/mission-bar-view.js";
import type { InboxDue, InboxRow } from "../stage-module.js";
import { stage1MailText, STAGE1_MEMO_ROW_ID } from "./s1-view.js";
import type { Stage1Row } from "./s1-view.js";

/*
 * What Stage 1's screen draws (the mock's s1PaintMail, s1Center, s1ShowResultWin, s1Say). Pure:
 * the components only draw what these return.
 */

const dueOf = (row: Stage1Row, now: number): InboxDue => {
  if (row.status === "done") return { text: stage1ScreenText.replied, ratio: null, hot: false };
  if (row.status === "missed") return { text: stage1ScreenText.expired, ratio: null, hot: false };
  const { text, hot } = countdown({ at: row.dueAt, label: null, overText: null }, now);
  return { text, ratio: (row.dueAt - now) / STAGE1_REPLY_LIMIT_MS, hot };
};

/**
 * The inbox pane's rows: the memo pinned on top, then the round's mails as `stage1Rows` orders
 * them. Only a live row opens; the heading counts the round's live mails (not the memo, as in
 * the mock).
 */
export const stage1InboxRows = (rows: readonly Stage1Row[], now: number): InboxRow[] =>
  rows.map((row) => ({
    id: row.id,
    from: row.from,
    subject: row.subject,
    opens: { kind: "center" },
    pinned: row.pinned,
    due: dueOf(row, now),
    closed: row.status !== "live",
    unread: row.status === "live" && !row.pinned,
  }));

/**
 * What the centre pane shows.
 * - waiting: the briefing is up and the stage has not started.
 * - memo / mail: the open handover memo or mail, with its reply box.
 * - round-end: a failed round's window is up (the centre repeats its heading and note).
 * - cleared / idle: the closing note, or the note to open a mail.
 */
export type Stage1CenterMode = "waiting" | "memo" | "mail" | "round-end" | "cleared" | "idle";

export const stage1CenterMode = (
  s1: Stage1State | null,
  rows: readonly Stage1Row[],
  openId: string | null,
): Stage1CenterMode => {
  if (s1 === null) return "waiting";
  const open = openId !== null && rows.some((row) => row.id === openId && row.status === "live");
  // The memo is not the round's: it may be read and answered whatever the phase (mock).
  if (open && openId === STAGE1_MEMO_ROW_ID) return "memo";
  if (s1.status.phase === "round-result") return "round-end";
  if (s1.status.phase === "cleared") return "cleared";
  return open ? "mail" : "idle";
};

/** Whether the open mail should be closed: it is no longer live (answered, expired, gone). */
export const stage1ShouldClose = (rows: readonly Stage1Row[], openId: string | null): boolean =>
  openId !== null && !rows.some((row) => row.id === openId && row.status === "live");

const LOG_SHOWN = 8;

/**
 * The centre's log (the mock's s1Say): one line for each row that was live in `before` and is
 * done or missed in `after`, newest first, kept to the mock's eight lines.
 */
export const stage1LogAfter = (
  log: readonly string[],
  before: readonly Stage1Row[],
  after: readonly Stage1Row[],
): readonly string[] => {
  const added = after.flatMap((row) => {
    const was = before.find((candidate) => candidate.id === row.id);
    if (was?.status !== "live" || row.status === "live") return [];
    const say = row.status === "done" ? stage1ScreenText.logReplied : stage1ScreenText.logExpired;
    return [say(row.subject)];
  });
  return added.length === 0 ? log : [...added.reverse(), ...log].slice(0, LOG_SHOWN);
};

/** One curt reply as the R1 window threads it: their mail, the reply, their puzzled answer. */
export interface Stage1Thread {
  readonly heading: string;
  readonly mail: string;
  readonly reply: string;
  readonly answerFrom: string;
  readonly answer: string;
}

export interface Stage1RoundEnd {
  readonly heading: string;
  readonly note: string;
  /** 「……ほか N件」 under the note (R1) or under the voices (R2・R3), or `null`. */
  readonly rest: string | null;
  readonly admin: string;
  /** R1: the curt replies as threads (two at most). */
  readonly threads: readonly Stage1Thread[];
  /** R2・R3: one puzzled voice per curt reply (four at most). */
  readonly voices: readonly string[];
  readonly button: string;
}

const THREADS_SHOWN = 2;
const VOICES_SHOWN = 4;

const adminLine = (missed: number, curt: number): string => {
  const { admin } = stage1ResultText;
  if (missed > 0) return curt > 0 ? admin.missedAndCurt(missed) : admin.missed(missed);
  return admin.curt;
};

const threadsOf = (s1: Stage1State): Stage1Thread[] =>
  s1.curt.slice(0, THREADS_SHOWN).flatMap(({ mailId, reply }) => {
    const mail = stage1MailText(mailId);
    if (mail === null) return [];
    return [
      {
        heading: mail.from + "　" + mail.subj,
        mail: mail.body[0] ?? "",
        reply,
        answerFrom: stage1ResultText.theirReply(mail.from),
        answer: mail.sad ?? "",
      },
    ];
  });

const voicesOf = (s1: Stage1State): string[] =>
  s1.curt.slice(0, VOICES_SHOWN).map(({ mailId }, i) => {
    const from = stage1MailText(mailId)?.from ?? "";
    return `〔${from}〕${stage1CurtVoices[i % stage1CurtVoices.length] ?? ""}`;
  });

/**
 * A failed round's window (the mock's s1ShowResultWin for round1〜3), or `null` while no round
 * has failed. The window is the server's phase, so a reload shows it again.
 */
export const stage1RoundEnd = (s1: Stage1State, now: number): Stage1RoundEnd | null => {
  if (s1.status.phase !== "round-result") return null;
  const { total, done, missed, curt } = stage1RoundSummary(s1, now);
  const notes = stage1ResultText.notes[s1.round];
  const shown = s1.round === 1 ? THREADS_SHOWN : VOICES_SHOWN;
  return {
    heading: stage1ResultText.heading(stage1AttemptNo(s1)),
    note: missed > 0 ? notes.timeout(done, total) : notes.curt,
    rest: curt > shown ? stage1ResultText.rest(curt - shown) : null,
    admin: adminLine(missed, curt),
    threads: s1.round === 1 ? threadsOf(s1) : [],
    voices: s1.round === 1 ? [] : voicesOf(s1),
    button: s1.round === 3 ? stage1ResultText.again : stage1ResultText.next,
  };
};

/** The window that says Stage 1 is cleared (the mock's s1ShowResultWin for manual / ai). */
export interface Stage1ClearWindow {
  readonly heading: string;
  readonly note: string;
  readonly button: string;
}

/**
 * The clear's window, or `null` while Stage 1 is not cleared. The director is not in it: he
 * speaks first in the clear effect's ③ right after (mock, 2026-09-11 decision). A clean round
 * has no curt reply, so there are no voices to list.
 */
export const stage1ClearWindow = (s1: Stage1State | null): Stage1ClearWindow | null => {
  if (s1?.status.phase !== "cleared") return null;
  return {
    heading: stage1ScreenText.cleared,
    note: stage1ResultText.clearedNotes[s1.status.result],
    button: stage1ResultText.next,
  };
};

/** The mission bar counts down the open mail's minute (the mock's #s1-timer). */
export const stage1MissionDeadline = (
  state: TeamGameViewState,
  focus: StageFocus,
): MissionDeadline | null => {
  const s1 = state.s1;
  if (s1 === null || focus === null) return null;
  const at =
    focus === STAGE1_MEMO_ROW_ID
      ? stage1MemoDeadlineAt(s1)
      : stage1Mails(s1, 0).find((mail) => mail.id === focus)?.dueAt;
  return at === undefined ? null : { at, label: null, overText: null };
};
