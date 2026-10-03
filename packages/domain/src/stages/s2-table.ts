import { stage2Columns } from "@hell-ict/content";
import { z } from "zod";

/**
 * Stage 2 (line list): reading a pasted table, and the model answer that normalises the sheet.
 * Ported from the mock's `S2_COLS`, `parseCsv`, `parseTable`, `s2SendTableToGrid` (only its
 * decision), `zen2han`, `isoDate` and `normalizeRows` (hell-ict-archive:docs/ui/mock/index.html).
 */

/**
 * The grid's fixed columns (content's `stage2Columns`). A header row naming any of them is
 * dropped from a paste.
 */
export const STAGE2_COLUMNS = stage2Columns;

/** One grid row: always six cells, in `STAGE2_COLUMNS` order. */
export const stage2RowSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

export type Stage2Row = z.infer<typeof stage2RowSchema>;

export const stage2GridSchema = z.array(stage2RowSchema);

export type Stage2Grid = z.infer<typeof stage2GridSchema>;

/**
 * Why a pasted table is refused (the mock's error bar):
 * - unclosed-quote: a CSV quote never closes.
 * - too-many-columns: a value beyond the sixth column; `row` is 1-based, as the mock shows it.
 * - no-delimiter: several lines, but no tab, comma or `|` separates cells.
 */
export type Stage2TableError =
  | { reason: "unclosed-quote" }
  | { reason: "too-many-columns"; row: number }
  | { reason: "no-delimiter" };

/** The mock's three results: rows, an error, or `null` (not a table: one line, or no cells). */
export type Stage2TableParse =
  | { kind: "rows"; rows: Stage2Row[] }
  | ({ kind: "error" } & Stage2TableError)
  | { kind: "not-a-table" };

interface CsvCursor {
  rows: string[][];
  row: string[];
  cell: string;
  quoted: boolean;
}

/** One character inside quotes. Returns how many characters were consumed. */
const readQuoted = (cursor: CsvCursor, text: string, index: number): number => {
  const ch = text.charAt(index);
  if (ch !== '"') {
    cursor.cell += ch;
    return 1;
  }
  if (text.charAt(index + 1) === '"') {
    cursor.cell += '"';
    return 2;
  }
  cursor.quoted = false;
  return 1;
};

const readPlain = (cursor: CsvCursor, ch: string): void => {
  if (ch === '"' && cursor.cell === "") {
    cursor.quoted = true;
  } else if (ch === ",") {
    cursor.row.push(cursor.cell);
    cursor.cell = "";
  } else if (ch === "\n") {
    cursor.row.push(cursor.cell);
    cursor.rows.push(cursor.row);
    cursor.row = [];
    cursor.cell = "";
  } else {
    cursor.cell += ch;
  }
};

/**
 * RFC 4180-like CSV: commas and line breaks inside quotes, `""` as an escaped quote. `null` when
 * a quote is left open. Cells are trimmed and blank rows dropped.
 */
export const parseCsv = (text: string): string[][] | null => {
  const cursor: CsvCursor = { rows: [], row: [], cell: "", quoted: false };
  let index = 0;
  while (index < text.length) {
    if (cursor.quoted) {
      index += readQuoted(cursor, text, index);
    } else {
      readPlain(cursor, text.charAt(index));
      index += 1;
    }
  }
  if (cursor.quoted) return null;
  cursor.row.push(cursor.cell);
  cursor.rows.push(cursor.row);
  return cursor.rows
    .map((row) => row.map((cell) => cell.trim()))
    .filter((row) => row.some((cell) => cell !== ""));
};

const nonBlankLines = (text: string): string[] => text.split("\n").filter((l) => l.trim() !== "");

const MARKDOWN_RULE_CELL = /^:?-{2,}:?$/;

const parseMarkdown = (text: string): string[][] =>
  nonBlankLines(text)
    .map((line) =>
      line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((row) => !row.every((cell) => MARKDOWN_RULE_CELL.test(cell)));

const parseTsv = (text: string): string[][] =>
  nonBlankLines(text).map((line) => line.split("\t").map((cell) => cell.trim()));

/** Line endings unified, outer blank space and a surrounding ``` fence removed. */
const unwrapPaste = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/^```[^\n]*\n/, "")
    .replace(/\n```$/, "");

type RawRows = string[][] | { kind: "error"; reason: "unclosed-quote" } | null;

/** Markdown first, then tabs, then CSV — the mock's order. `null` when none applies. */
const splitCells = (text: string): RawRows => {
  if (text.trim().startsWith("|")) return parseMarkdown(text);
  if (text.includes("\t")) return parseTsv(text);
  if (!text.includes(",")) return null;
  return parseCsv(text) ?? { kind: "error", reason: "unclosed-quote" };
};

const COLUMN_NAMES: readonly string[] = STAGE2_COLUMNS;

const isHeaderRow = (row: readonly string[]): boolean =>
  row.some((cell) => COLUMN_NAMES.includes(cell.replace(/\s/g, "")));

const toGridRow = (row: readonly string[]): Stage2Row => [
  row[0] ?? "",
  row[1] ?? "",
  row[2] ?? "",
  row[3] ?? "",
  row[4] ?? "",
  row[5] ?? "",
];

const shapeRows = (rows: string[][]): Stage2TableParse => {
  const body =
    rows.length > 1 && rows[0] !== undefined && isHeaderRow(rows[0]) ? rows.slice(1) : rows;
  if (body.length === 0) return { kind: "not-a-table" };
  // A value beyond the sixth cell. Empty cells there (a trailing tab) are dropped silently.
  const wide = body.findIndex((row) => row.slice(STAGE2_COLUMNS.length).some((c) => c !== ""));
  if (wide !== -1) return { kind: "error", reason: "too-many-columns", row: wide + 1 };
  if (body.every((row) => row.length <= 1)) return { kind: "error", reason: "no-delimiter" };
  return { kind: "rows", rows: body.map(toGridRow) };
};

/**
 * The mock's `parseTable`: whatever shape the AI answers in (CSV, Markdown, tabs, fenced), the
 * table must go in — this is where the AI route joins the grid. Short rows are padded to six
 * cells; a header row is dropped since the columns are fixed.
 */
export const parseStage2Table = (text: string): Stage2TableParse => {
  const unwrapped = unwrapPaste(text);
  if (!unwrapped.includes("\n")) return { kind: "not-a-table" };
  const rows = splitCells(unwrapped);
  if (rows === null) return { kind: "not-a-table" };
  if (!Array.isArray(rows)) return rows;
  return shapeRows(rows);
};

/**
 * What `[表に送る]` and a multi-line paste do with a text (the mock's `s2SendTableToGrid`): a
 * table replaces the grid; anything else is refused, never poured into one cell.
 */
export const readStage2TableForGrid = (
  text: string,
): { kind: "rows"; rows: Stage2Row[] } | ({ kind: "error" } & Stage2TableError) => {
  const parsed = parseStage2Table(text);
  return parsed.kind === "not-a-table" ? { kind: "error", reason: "no-delimiter" } : parsed;
};

const toHalfWidthDigits = (text: string): string =>
  text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The sampling date as YYYY-MM-DD. The one unreadable date (「さんにち」) becomes 要確認. */
export const toIsoDate = (value: string): string => {
  const cleaned = toHalfWidthDigits(value)
    .replace(/[年月]/g, "/")
    .replace(/日/g, "")
    .replace(/^[RrHh]\d+[./-]/, "");
  const [first, second, third] = (cleaned.match(/\d+/g) ?? []).map(Number);
  if (first === undefined || second === undefined) return "要確認";
  if (third === undefined) return `2026-${pad2(first)}-${pad2(second)}`;
  return `${String(first)}-${pad2(second)}-${pad2(third)}`;
};

const POSITIVE_MRSA = /陽性|\(\+\)|ポジ|＋/;

/** A noise row has a value only in its first cell (the title line, the blank line). */
const isNoiseRow = (row: Stage2Row): boolean => row.slice(1).every((cell) => cell === "");

/**
 * The model answer (the mock's `normalizeRows`): what a team makes the AI do. Noise rows go,
 * ids become three digits, the ward is 5A, dates are ISO, MRSA is 陽性/陰性, and a temperature
 * counts as fever. The note is kept as written.
 */
export const normalizeStage2Rows = (rows: readonly Stage2Row[]): Stage2Row[] =>
  rows
    .filter((row) => !isNoiseRow(row))
    .map(([id, , date, mrsa, fever, note]) => [
      toHalfWidthDigits(id).replace(/\D/g, "").padStart(3, "0"),
      "5A",
      toIsoDate(date),
      POSITIVE_MRSA.test(mrsa) ? "陽性" : "陰性",
      fever.trim() === "なし" ? "なし" : "あり",
      note,
    ]);
