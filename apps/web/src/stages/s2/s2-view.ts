import {
  stage2AddendumMail,
  stage2AddendumRows,
  stage2CheckLabels,
  stage2CheckLine,
  stage2ClearedText,
  stage2Mail,
  stage2RejectReasons,
  stage2RetryLine,
  stage2SheetRows,
  stage2SubmitFailed,
} from "@hell-ict/content";
import {
  isStage2AddendumLanded,
  isStage2AddendumTaken,
  resetStage2Grid,
  STAGE2_ADDENDUM_ROW_COUNT,
  STAGE2_CHECK_IDS,
} from "@hell-ict/domain";
import type {
  Stage2CheckId,
  Stage2Grid,
  Stage2Judgement,
  Stage2Row,
  Stage2State,
} from "@hell-ict/domain";
import { z } from "zod";

import type { SendOutcome } from "../../composables/use-game-session.js";
import type { Verdict } from "../../verdict/verdict.js";
import type { InboxRow } from "../stage-module.js";

/*
 * Stage 2 by hand (mock renderStage2Excel, drawGrid, runVerdict, renderMails): the grid's edits,
 * the inbox, and the verdict under a submission. Pure: use-stage2 keeps the state, the
 * components only draw it. The judge is the server's (`s2.submit`); this only words its answer.
 */

export const STAGE2_MAIL_ROW_ID = "s2-main";
export const STAGE2_ADDENDUM_ROW_ID = "s2-add";

/** A lit cell of the grid, as the mock's `"row-column"` keys. */
export const cellKey = (row: number, column: number): string => `${String(row)}-${String(column)}`;

const NO_CELLS: ReadonlySet<string> = new Set();

const copyRows = (rows: readonly (readonly string[])[]): Stage2Grid =>
  rows.map(
    (row): Stage2Row => [
      row[0] ?? "",
      row[1] ?? "",
      row[2] ?? "",
      row[3] ?? "",
      row[4] ?? "",
      row[5] ?? "",
    ],
  );

/** The delivered sheet's rows, noise rows and all. */
export const stage2SheetGridRows = (): Stage2Grid => copyRows(stage2SheetRows);

/** The addendum's ten rows, as they go into the grid on ［表に追加］. */
export const stage2AddendumGridRows = (): Stage2Grid => copyRows(stage2AddendumRows);

/**
 * The grid as delivered (the mock's reset): the sheet, plus the addendum once it is taken — a
 * team going back to the start keeps what it already took in.
 */
export const stage2FreshGrid = (state: Stage2State): Stage2Grid =>
  resetStage2Grid(state, stage2SheetGridRows(), stage2AddendumGridRows());

/** `grid` with one cell changed. A cell outside the grid changes nothing. */
export const withCell = (
  grid: Stage2Grid,
  row: number,
  column: number,
  value: string,
): Stage2Grid =>
  grid.map((cells, index): Stage2Row => {
    if (index !== row) return cells;
    const next: Stage2Row = [...cells];
    if (column >= 0 && column < next.length) next[column] = value;
    return next;
  });

export const withEmptyRow = (grid: Stage2Grid): Stage2Grid => [...grid, ["", "", "", "", "", ""]];

/**
 * `grid` without the row, and the lit cells moved up with the rows under it (the mock's delete:
 * the deleted row's cells go, the ones below keep pointing at their own cells).
 */
export const withoutRow = (
  grid: Stage2Grid,
  hot: ReadonlySet<string>,
  row: number,
): { readonly grid: Stage2Grid; readonly hot: ReadonlySet<string> } => {
  const moved = [...hot].flatMap((key) => {
    const [r = -1, c = -1] = key.split("-").map(Number);
    if (r === row) return [];
    return [cellKey(r > row ? r - 1 : r, c)];
  });
  return { grid: grid.filter((_, index) => index !== row), hot: new Set(moved) };
};

export const withoutCell = (
  hot: ReadonlySet<string>,
  row: number,
  column: number,
): ReadonlySet<string> => {
  const key = cellKey(row, column);
  return hot.has(key) ? new Set([...hot].filter((k) => k !== key)) : hot;
};

/** The two mails of the stage, newest first: the request, and the addendum once it has landed. */
export const stage2InboxRows = (state: Stage2State | null, nowMs: number): readonly InboxRow[] => {
  // The request is read the moment the stage opens (mock readS1): it is what the grid holds.
  const request: InboxRow = {
    id: STAGE2_MAIL_ROW_ID,
    from: stage2Mail.from,
    subject: stage2Mail.subj,
    attach: stage2Mail.attach,
    opens: { kind: "viewer", doc: "main" },
    unread: false,
  };
  if (state === null || !isStage2AddendumLanded(state, nowMs)) return [request];
  const addendum: InboxRow = {
    id: STAGE2_ADDENDUM_ROW_ID,
    from: stage2AddendumMail.from,
    subject: stage2AddendumMail.subj,
    attach: stage2AddendumMail.attach,
    opens: { kind: "viewer", doc: "add" },
  };
  return [addendum, request];
};

/** ［表に追加］ is offered: the addendum has landed and is not in the table yet. */
export const stage2CanTake = (state: Stage2State | null, nowMs: number): boolean =>
  state !== null && isStage2AddendumLanded(state, nowMs) && !isStage2AddendumTaken(state);

const cellSchema = z
  .object({ row: z.number().int().nonnegative(), column: z.number().int().nonnegative() })
  .strict();

/** The judge's answer as the server sends it (`judgement` is JSON, checked here). */
export const stage2JudgementSchema = z.union([
  z.object({ outcome: z.literal("pass") }).strict(),
  z
    .object({
      outcome: z.literal("reject"),
      check: z.enum(["required-cells", "collection-date", "mrsa-result"]),
      cells: z.array(cellSchema),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("reject"),
      check: z.literal("row-count"),
      reason: z.enum(["addendum-not-taken", "count-mismatch"]),
      expected: z.number().int(),
      actual: z.number().int(),
    })
    .strict(),
]) satisfies z.ZodType<Stage2Judgement>;

const checkLabel = (check: Stage2CheckId, expectedRows: number): string => {
  if (check === "required-cells") return stage2CheckLabels.requiredCells;
  if (check === "collection-date") return stage2CheckLabels.collectionDate;
  if (check === "mrsa-result") return stage2CheckLabels.mrsaResult;
  return stage2CheckLabels.rowCount(expectedRows);
};

type Stage2Reject = Extract<Stage2Judgement, { outcome: "reject" }>;

const rejectReason = (judgement: Stage2Reject): string => {
  if (judgement.check === "row-count") {
    return judgement.reason === "addendum-not-taken"
      ? stage2RejectReasons.addendumNotTaken(STAGE2_ADDENDUM_ROW_COUNT)
      : stage2RejectReasons.countMismatch(judgement.expected, judgement.actual);
  }
  const count = judgement.cells.length;
  if (judgement.check === "required-cells") return stage2RejectReasons.requiredCells(count);
  if (judgement.check === "collection-date") return stage2RejectReasons.collectionDate(count);
  return stage2RejectReasons.mrsaResult(count);
};

/**
 * The verdict's rows (mock runVerdict): the checks passed, the one that failed with why, the
 * next one halted, and the line that says to fix and resubmit. A pass ticks every check, in the
 * same words, before the line of success. `expectedRows` names the row check (20, or 30 once the
 * addendum has landed).
 */
export const stage2Verdict = (judgement: Stage2Judgement, expectedRows: number): Verdict => {
  if (judgement.outcome === "pass") {
    return {
      kind: "cleared",
      text: stage2ClearedText,
      checks: STAGE2_CHECK_IDS.map((id) => stage2CheckLine.pass(checkLabel(id, expectedRows))),
    };
  }
  const expected = judgement.check === "row-count" ? judgement.expected : expectedRows;
  const labels = STAGE2_CHECK_IDS.map((id) => checkLabel(id, expected));
  const failAt = STAGE2_CHECK_IDS.indexOf(judgement.check);
  const halted = labels[failAt + 1];
  return {
    kind: "rejected",
    lines: [
      ...labels.slice(0, failAt).map(stage2CheckLine.pass),
      stage2CheckLine.fail(labels[failAt] ?? "", rejectReason(judgement)),
      ...(halted === undefined ? [] : [stage2CheckLine.halt(halted)]),
      stage2RetryLine,
    ],
  };
};

/** The cells a rejection points at (none for the row count). */
export const stage2HotCells = (judgement: Stage2Judgement): ReadonlySet<string> =>
  judgement.outcome === "reject" && judgement.check !== "row-count"
    ? new Set(judgement.cells.map((cell) => cellKey(cell.row, cell.column)))
    : NO_CELLS;

export interface Stage2SubmitResult {
  readonly verdict: Verdict;
  readonly hot: ReadonlySet<string>;
  /** A rejection by the judge (the `cancel` sound); not a submission that never arrived. */
  readonly rejected: boolean;
}

const NOT_DELIVERED: Stage2SubmitResult = {
  verdict: { kind: "rejected", lines: [stage2SubmitFailed] },
  hot: NO_CELLS,
  rejected: false,
};

/**
 * What `s2.submit` came to on screen. Only a judged submission (applied, or a resend answered
 * `duplicate` with the first judgement) has a verdict of its own; anything else (no answer, a
 * refusal, an answer the screen cannot read) asks to submit again.
 */
export const stage2SubmitResult = (
  outcome: SendOutcome,
  expectedRows: number,
): Stage2SubmitResult => {
  if (outcome.kind !== "done" || outcome.response.status === "rejected") return NOT_DELIVERED;
  // A resend that the server had already applied comes back `duplicate`: read it by what its
  // first application judged.
  const { response } = outcome;
  const judgement =
    response.status === "duplicate" ? response.original.judgement : response.judgement;
  const parsed = stage2JudgementSchema.safeParse(judgement);
  if (!parsed.success) return NOT_DELIVERED;
  return {
    verdict: stage2Verdict(parsed.data, expectedRows),
    hot: stage2HotCells(parsed.data),
    rejected: parsed.data.outcome === "reject",
  };
};
