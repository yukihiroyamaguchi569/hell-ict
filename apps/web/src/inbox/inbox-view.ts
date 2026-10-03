import type { GameStageId } from "@hell-ict/domain";

import type { InboxOpen, InboxRow } from "../stages/stage-module.js";

/*
 * The inbox in the left pane (mock renderMails / s1List). Pure: InboxList.vue only draws it.
 * The rows are the stage's; the frame adds what has been read and which one is open. The
 * Prologue's three mails live in the Prologue's own rows (#281), never here, so Stage 1 onwards
 * cannot show them.
 */

export interface InboxItem {
  readonly row: InboxRow;
  /** Drawn as read (○, muted): opened, or closed. */
  readonly read: boolean;
  /** The one the centre has open (mock aria-current). */
  readonly current: boolean;
}

export interface InboxView {
  readonly items: readonly InboxItem[];
  /** The heading's badge; hidden at 0. */
  readonly unread: number;
}

/**
 * Keeps the first row of each id. The id is the row's key on screen: two rows with one key
 * would be patched into each other.
 */
const uniqueRows = (rows: readonly InboxRow[]): readonly InboxRow[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
};

const countsAsUnread = (row: InboxRow, read: boolean): boolean => row.unread ?? !read;

export const inboxView = (
  rows: readonly InboxRow[],
  readIds: ReadonlySet<string>,
  openId: string | null,
): InboxView => {
  const items = uniqueRows(rows).map((row) => ({
    row,
    read: row.closed === true || readIds.has(row.id),
    current: row.id === openId,
  }));
  return {
    items,
    unread: items.filter((item) => countsAsUnread(item.row, item.read)).length,
  };
};

/** What pressing the row with `id` does: nothing for a row that is gone or closed. */
export const inboxAction = (rows: readonly InboxRow[], id: string): InboxOpen | null => {
  const row = rows.find((candidate) => candidate.id === id);
  return row === undefined || row.closed === true ? null : row.opens;
};

/** The width of a due bar, clamped to 0〜100 %. */
export const dueBarWidth = (ratio: number): string =>
  `${String(Math.max(0, Math.min(100, ratio * 100)))}%`;

/** The row ids of one draw of the inbox, with the stage it was drawn in. */
export interface InboxDraw {
  readonly stage: GameStageId;
  readonly ids: readonly string[];
}

/**
 * The rows that shake as they land (mock `.mail.landing`): the ones `next` shows that the
 * previous draw did not, and those still landing from before while they stay on screen.
 * Nothing shakes on the first draw (`previous` undefined: rows already there after a reload
 * have landed before, 2026-09-27 decision) nor when the stage changes: a new stage's inbox
 * arrives whole, it does not land row by row.
 */
export const landingIds = (
  landing: ReadonlySet<string>,
  previous: InboxDraw | undefined,
  next: InboxDraw,
): ReadonlySet<string> => {
  if (previous === undefined || previous.stage !== next.stage) return new Set();
  const before = new Set(previous.ids);
  return new Set(next.ids.filter((id) => landing.has(id) || !before.has(id)));
};
