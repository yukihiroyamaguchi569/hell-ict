/**
 * Stage 5 (the health-centre fever list) judges, ported from the mock
 * (hell-ict-archive:docs/ui/mock/index.html: sendAI's S5_PII gate, checkStage5 and its helpers).
 * The behaviour matches the mock, except that a rejected submission lists every reason it
 * found instead of the first one (#221); where to pass and where to reject is unchanged.
 *
 * No judgement echoes the submitted text: the fever list may still carry patient
 * names, so results carry codes, labels and patient IDs only.
 */
import { stage5FeverRows } from "@hell-ict/content";

import { detectPii } from "../pii.js";
import type { PiiLabel } from "../pii.js";
import type { StageJudgement } from "../schemas/game.js";

export type S5FeverId = (typeof stage5FeverRows)[number]["id"];

/**
 * Patient IDs of the fever list, taken from content's `stage5FeverRows` (the mock's
 * S5_FEVER_ROWS) in its order — the order the missing IDs are reported in. content is the single
 * source of the rows.
 */
export const S5_FEVER_IDS: readonly S5FeverId[] = stage5FeverRows.map((row) => row.id);

/**
 * The gate in front of the AI chat. A hit is the trap (the state machine decides whether
 * it is the first one); `null` means the message may be sent. Only the label is returned,
 * never the matched text. The `satisfies` below keeps every judgement a StageJudgement, so the
 * caller can wrap its outcome in `record-judgement`.
 */
export type S5GateJudgement = { outcome: "trap"; detected: PiiLabel };

export const judgeS5AiMessage = ((text: string): S5GateJudgement | null => {
  const detected = detectPii(text);
  return detected === null ? null : { outcome: "trap", detected };
}) satisfies (text: string) => StageJudgement | null;

/** Same values as the mock's `reason` in the verdict.s5 activity log. */
export type S5FormatRejectReason = "fullwidth" | "date" | "temp";

/** One reason a submission is sent back. `ids` carries the missing IDs in S5_FEVER_IDS order. */
export type S5RejectReason =
  | { reason: "ids"; missingIds: S5FeverId[] }
  | { reason: S5FormatRejectReason };

/** A reject carries every reason found, in the mock's check order: ids, fullwidth, date, temp. */
export type S5SubmissionJudgement =
  | { outcome: "pass" }
  | { outcome: "reject"; reasons: [S5RejectReason, ...S5RejectReason[]] };

/**
 * Date styles. Year-first ISO comes first so "2026-07-30" is not read as M-D.
 * The capture groups are month and day.
 */
const DATE_FORMATS = [
  { key: "ISOハイフン", anchored: /^\d{4}-(\d{1,2})-(\d{1,2})$/ },
  { key: "ISOスラッシュ", anchored: /^\d{4}\/(\d{1,2})\/(\d{1,2})$/ },
  { key: "和暦", anchored: /^[RH]\d{1,2}[./](\d{1,2})[./](\d{1,2})$/ },
  { key: "M月D日", anchored: /^(?:\d{4}年)?(\d{1,2})月(\d{1,2})日$/ },
  { key: "M/D", anchored: /^(\d{1,2})\/(\d{1,2})$/ },
  { key: "M-D", anchored: /^(\d{1,2})-(\d{1,2})$/ },
  { key: "M.D", anchored: /^(\d{1,2})\.(\d{1,2})$/ },
] as const;

/** Scans date-like tokens (same alternatives as DATE_FORMATS), bounded by non-digits. */
const DATE_SCAN =
  /(?<!\d)(?:\d{4}-\d{1,2}-\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2}|[RH]\d{1,2}[./]\d{1,2}[./]\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}|\d{1,2}-\d{1,2}|\d{1,2}\.\d{1,2})(?!\d)/g;

const isCalendarDay = (month: number, day: number): boolean =>
  month >= 1 && month <= 12 && day >= 1 && day <= 31;

/**
 * Classifies one token. Out-of-range month/day is not a date (so the body temperature
 * "38.6" is not M.D). The first matching format decides, as in the mock.
 */
const dateStyle = (token: string): string | null => {
  for (const format of DATE_FORMATS) {
    const match = format.anchored.exec(token);
    if (match === null) continue;
    return isCalendarDay(Number(match[1]), Number(match[2])) ? format.key : null;
  }
  return null;
};

/** Distinct date styles in the text; more than one means the dates are not unified. */
const dateStyles = (text: string): Set<string> => {
  const styles = new Set<string>();
  for (const token of text.match(DATE_SCAN) ?? []) {
    const style = dateStyle(token);
    if (style !== null) styles.add(style);
  }
  return styles;
};

/**
 * Whether temperatures with and without a unit are mixed. Only 37.0–40.9 counts as a
 * temperature; ℃, °C, ゜C and 度 all count as "with a unit".
 */
const tempUnitMixed = (text: string): boolean => {
  const withUnit = Array.from(
    text.matchAll(/(?<!\d)(?:3[7-9]|40)\.\d(?!\d)[ \u3000]*(℃|°C|゜C|度)?/g),
    (match) => match[1] !== undefined,
  );
  return withUnit.includes(true) && withUnit.includes(false);
};

const ID_TOKEN = new RegExp(`(?<!\\d)(?:${S5_FEVER_IDS.join("|")})(?!\\d)`);
/** A tab, a pipe, or two or more spaces count as one separator. */
const TABLE_SEP = /\t|\||[ \u3000]{2,}/g;
/** Loose separator: a single space also counts (a list whose tabs became single spaces). */
const TABLE_SEP_LOOSE = /\t|\||[ \u3000]+/g;

/**
 * The data rows of the submitted list: lines with a patient ID as a token and at least two
 * separators, so a preface or a Markdown divider is not format-checked. When fewer rows than
 * `expectedRows` (the IDs the text holds; 14 for a complete list, as in the mock) are found,
 * retry with the loose separator. Counting only the IDs present keeps a tab table that lacks a
 * row from falling back to the loose separator and picking up prose lines.
 */
const dataLines = (text: string, expectedRows: number): string[] => {
  const withId = text.split("\n").filter((line) => ID_TOKEN.test(line));
  const separated = (sep: RegExp): string[] =>
    withId.filter((line) => (line.match(sep) ?? []).length >= 2);
  const tableLines = separated(TABLE_SEP);
  return tableLines.length >= expectedRows ? tableLines : separated(TABLE_SEP_LOOSE);
};

/** Full-width digits read as ASCII, so the date and unit checks see the value behind them. */
const toHalfwidthDigits = (text: string): string =>
  text.replace(/[０-９]/g, (digit) => String((digit.codePointAt(0) ?? 0) - 0xff10));

/**
 * Every format problem in the data rows. The date and unit checks look through full-width
 * digits: "８月３日" among ISO dates is still a second style once the digits are fixed, so it
 * is reported now rather than on the next submission.
 */
const formatRejectReasons = (data: string): S5RejectReason[] => {
  const halfwidth = toHalfwidthDigits(data);
  const found: [S5FormatRejectReason, boolean][] = [
    ["fullwidth", halfwidth !== data],
    ["date", dateStyles(halfwidth).size > 1],
    ["temp", tempUnitMixed(halfwidth)],
  ];
  return found.filter(([, hit]) => hit).map(([reason]) => ({ reason }));
};

/**
 * The submission to the health centre (checkStage5). Reject only, never a trap: names left
 * in the list are not blocked here (the health centre is a legitimate recipient). The ID
 * coverage looks at the whole text as a plain substring, as in the mock; the format checks
 * look at the data rows only. Missing IDs do not stop the format checks: the rows that are
 * there can be fixed in the same round. A text with no data rows yields no format reasons.
 */
export const judgeS5Submission = ((text: string): S5SubmissionJudgement => {
  const missingIds = S5_FEVER_IDS.filter((id) => !text.includes(id));
  const idReasons: S5RejectReason[] = missingIds.length > 0 ? [{ reason: "ids", missingIds }] : [];
  const data = dataLines(text, S5_FEVER_IDS.length - missingIds.length).join("\n");
  const [first, ...rest] = [...idReasons, ...formatRejectReasons(data)];
  return first === undefined
    ? { outcome: "pass" }
    : { outcome: "reject", reasons: [first, ...rest] };
}) satisfies (text: string) => StageJudgement;

/**
 * The health centre's deadline for the fever list (the mock's S5_DEADLINE, 120 s), counted from
 * the team's entry into Stage 5 (`enteredAt.s5`, user decision 6 of 2026-09-27). Nothing is
 * locked when it passes: the head of administration calls once (the mock's s5ShowCall).
 */
export const STAGE5_DEADLINE_MS = 120_000;

/** When the deadline passes, as server epoch ms, from the entry instant (an ISO string). */
export const stage5DeadlineAt = (enteredAtIso: string): number =>
  Date.parse(enteredAtIso) + STAGE5_DEADLINE_MS;
