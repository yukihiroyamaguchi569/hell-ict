import { z } from "zod";

import type { StageJudgement } from "../schemas/game.js";
import { DEADLINE_GRACE_MS, epochMsSchema, secondsToMs } from "./deadline.js";
import { normalizeStage2Rows, STAGE2_COLUMNS } from "./s2-table.js";
import type { Stage2Grid, Stage2Row } from "./s2-table.js";

/**
 * Stage 2 (line list): the deadline, the addendum it brings, and the judge of the grid.
 * Ported from the mock's `S2_ROWS` / `S2_ROWS_ADD` / `S2_DEADLINE` / `S2_KARUBE_DELAY`,
 * `expectedRows`, `s2DeadlineFrame`, the `[表に追加]` handler, `checkGrid` and `s2ScriptedTable`
 * (hell-ict-archive:docs/ui/mock/index.html).
 *
 * Missing the deadline never locks the submission (Stage 2 must not get a team stuck): it only
 * adds work. Ten more rows land, and from then on the grid must hold all thirty.
 */

/** Patient rows in the sheet, noise rows excluded (the mock's `S2_ROWS`). */
export const STAGE2_BASE_ROW_COUNT = 20;

/** Rows in the addendum that lands at the deadline (`S2_ADDENDUM_ROWS.length`). */
export const STAGE2_ADDENDUM_ROW_COUNT = 10;

/** The mock's `S2_DEADLINE` (300 s), counted from the start of Stage 2. */
export const STAGE2_DEADLINE_MS = secondsToMs(300);

/** The mock's `S2_KARUBE_DELAY` (45 s): 苅部さん rings and the AI pane opens. */
export const STAGE2_AI_UNLOCK_DELAY_MS = secondsToMs(45);

/**
 * `startedAt` is the mock's `s2T0`. Whether the addendum has landed is not stored: it follows
 * from the clock, so it can land only once and never un-land. `addendumTakenAt` is when the team
 * pressed [表に追加] (the mock's `s2AddTaken`, with its time), or `null`. It can only be at or
 * after the deadline, so a state read back from storage cannot hold an addendum taken before it
 * landed.
 */
export const stage2StateSchema = z
  .object({ startedAt: epochMsSchema, addendumTakenAt: epochMsSchema.nullable() })
  .strict()
  .refine(
    (state) =>
      state.addendumTakenAt === null ||
      state.addendumTakenAt >= state.startedAt + STAGE2_DEADLINE_MS,
    { message: "the addendum was taken before it landed" },
  );

export type Stage2State = z.infer<typeof stage2StateSchema>;

export const startStage2 = (now: number): Stage2State => ({
  startedAt: now,
  addendumTakenAt: null,
});

/** The mock's `s2AddTaken`. */
export const isStage2AddendumTaken = (state: Stage2State): boolean =>
  state.addendumTakenAt !== null;

export const stage2DeadlineAt = (state: Stage2State): number =>
  state.startedAt + STAGE2_DEADLINE_MS;

/**
 * The addendum has landed (the screen shows 締切超過 and the mail arrives). The mock compares
 * whole seconds (`300 - floor(elapsed / 1000) <= 0`), which is the same as `elapsed >= 300 s`.
 */
export const isStage2AddendumLanded = (state: Stage2State, now: number): boolean =>
  now >= stage2DeadlineAt(state);

/** Whole seconds left on the countdown, as the mock shows them (`S2_DEADLINE - floor(...)`). */
export const stage2SecondsLeft = (state: Stage2State, now: number): number =>
  Math.max(0, STAGE2_DEADLINE_MS / 1_000 - Math.floor((now - state.startedAt) / 1_000));

export const isStage2AiUnlocked = (state: Stage2State, now: number): boolean =>
  now - state.startedAt >= STAGE2_AI_UNLOCK_DELAY_MS;

export type Stage2TakeJudgement =
  | { outcome: "accepted" }
  | { outcome: "reject"; reason: "not-landed" | "already-taken" };

/**
 * [表に追加] (the mock's `btn-take` handler). The mock shows the button only in the addendum's
 * viewer (so only after it landed) and ignores a second press. The flag and the rows change
 * together, so a resent press can neither lose the rows nor add them twice.
 */
export const takeStage2Addendum = (
  state: Stage2State,
  grid: Stage2Grid,
  addendum: readonly Stage2Row[],
  now: number,
): { state: Stage2State; grid: Stage2Grid; judgement: Stage2TakeJudgement } => {
  if (!isStage2AddendumLanded(state, now)) {
    return { state, grid, judgement: { outcome: "reject", reason: "not-landed" } };
  }
  if (isStage2AddendumTaken(state)) {
    return { state, grid, judgement: { outcome: "reject", reason: "already-taken" } };
  }
  return {
    state: { ...state, addendumTakenAt: now },
    grid: [...grid, ...addendum.map((row): Stage2Row => [...row])],
    judgement: { outcome: "accepted" },
  };
};

/**
 * [最初の状態に戻す] (the mock's `btn-reset` handler): the sheet as delivered, plus the addendum
 * if it has been taken — a team that goes back to the start keeps what it already took in.
 */
export const resetStage2Grid = (
  state: Stage2State,
  sheet: readonly Stage2Row[],
  addendum: readonly Stage2Row[],
): Stage2Grid =>
  [...sheet, ...(isStage2AddendumTaken(state) ? addendum : [])].map((row): Stage2Row => [...row]);

/** The row count on screen (「行数が N 行」): 30 once the addendum has landed, taken or not. */
export const stage2ExpectedRowCount = (state: Stage2State, now: number): number =>
  isStage2AddendumLanded(state, now)
    ? STAGE2_BASE_ROW_COUNT + STAGE2_ADDENDUM_ROW_COUNT
    : STAGE2_BASE_ROW_COUNT;

/**
 * Row counts the judge accepts. Differs from the mock on purpose (Issue #232): for
 * `DEADLINE_GRACE_MS` after the deadline both 20 and 30 pass. A grid submitted just before the
 * deadline arrives after it, and a team that took the addendum the moment it showed must not be
 * told to go back to 20 rows either.
 */
export const stage2AcceptedRowCounts = (state: Stage2State, now: number): readonly number[] => {
  const expected = stage2ExpectedRowCount(state, now);
  const inGrace = now < stage2DeadlineAt(state) + DEADLINE_GRACE_MS;
  return expected !== STAGE2_BASE_ROW_COUNT && inGrace
    ? [STAGE2_BASE_ROW_COUNT, expected]
    : [expected];
};

/** A cell to light up on the grid (0-based, as the mock's `"r-c"` keys). */
export interface Stage2Cell {
  row: number;
  column: number;
}

/** The four checks in on-screen order. Only the first failing one is reported. */
export const STAGE2_CHECK_IDS = [
  "required-cells",
  "collection-date",
  "mrsa-result",
  "row-count",
] as const;

export type Stage2CheckId = (typeof STAGE2_CHECK_IDS)[number];

type Stage2Reject = Extract<StageJudgement, { outcome: "reject" }>;

/**
 * Structurally a `StageJudgement`. The wording lives in content; the judge returns ids and the
 * numbers the mock puts into its sentences (the count is `cells.length`).
 * - row-count / addendum-not-taken: the addendum landed but is not in the grid yet.
 * - row-count / count-mismatch: any other wrong number of rows.
 */
export type Stage2Judgement =
  | Extract<StageJudgement, { outcome: "pass" }>
  | (Stage2Reject & {
      check: "required-cells" | "collection-date" | "mrsa-result";
      cells: Stage2Cell[];
    })
  | (Stage2Reject & {
      check: "row-count";
      reason: "addendum-not-taken" | "count-mismatch";
      expected: number;
      actual: number;
    });

/** The note column may stay empty; the other five may not. */
const REQUIRED_COLUMNS = 5;

const emptyRequiredCells = (grid: Stage2Grid): Stage2Cell[] =>
  grid.flatMap((row, rowIndex) =>
    row
      .slice(0, REQUIRED_COLUMNS)
      .flatMap((value, column) => (value.trim() === "" ? [{ row: rowIndex, column }] : [])),
  );

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_COLUMN = 2;
const MRSA_COLUMN = 3;

/** Dates not in YYYY-MM-DD. The first 要確認 is allowed (the unreadable 「さんにち」), no more. */
const badDateCells = (grid: Stage2Grid): Stage2Cell[] => {
  let vagueSeen = false;
  return grid.flatMap((row, rowIndex) => {
    const value = row[DATE_COLUMN].trim();
    if (ISO_DATE.test(value)) return [];
    if (value === "要確認" && !vagueSeen) {
      vagueSeen = true;
      return [];
    }
    return [{ row: rowIndex, column: DATE_COLUMN }];
  });
};

const badMrsaCells = (grid: Stage2Grid): Stage2Cell[] =>
  grid.flatMap((row, rowIndex) => {
    const value = row[MRSA_COLUMN].trim();
    return value === "陽性" || value === "陰性" ? [] : [{ row: rowIndex, column: MRSA_COLUMN }];
  });

const CELL_CHECKS = [
  ["required-cells", emptyRequiredCells],
  ["collection-date", badDateCells],
  ["mrsa-result", badMrsaCells],
] as const;

const judgeRowCount = (grid: Stage2Grid, state: Stage2State, now: number): Stage2Judgement => {
  if (stage2AcceptedRowCounts(state, now).includes(grid.length)) return { outcome: "pass" };
  const reason =
    isStage2AddendumLanded(state, now) && !isStage2AddendumTaken(state)
      ? "addendum-not-taken"
      : "count-mismatch";
  return {
    outcome: "reject",
    check: "row-count",
    reason,
    expected: stage2ExpectedRowCount(state, now),
    actual: grid.length,
  };
};

/**
 * The mock's `checkGrid`: rule-based only, no LLM, and quality is not scored. The fever column
 * is only required to be filled — its content is the seed Stage 3 picks up, so it is not judged.
 */
export const judgeStage2 = (grid: Stage2Grid, state: Stage2State, now: number): Stage2Judgement => {
  for (const [check, findCells] of CELL_CHECKS) {
    const cells = findCells(grid);
    if (cells.length > 0) return { outcome: "reject", check, cells };
  }
  return judgeRowCount(grid, state, now);
};

/**
 * The scripted AI answer of Stage 2 (the mock's `s2ScriptedTable`). Stage 2 never calls the real
 * API: whatever the prompt, the answer is the model answer as a tab-separated table with a header
 * row. The addendum is in it once it has landed (landed, not taken — the same basis as the row
 * count), so a late team that pastes it gets thirty rows without pressing [表に追加].
 * The sheet and the addendum are teaching material and come from content.
 */
export const stage2ScriptedTable = (
  sheet: readonly Stage2Row[],
  addendum: readonly Stage2Row[],
  addendumLanded: boolean,
): string =>
  [[...STAGE2_COLUMNS], ...normalizeStage2Rows(addendumLanded ? [...sheet, ...addendum] : sheet)]
    .map((row) => row.join("\t"))
    .join("\n");
