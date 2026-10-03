import { stage5IncidentReport } from "@hell-ict/content";

/**
 * The Stage 5 penalty: black out the personal information in an incident report
 * (the mock's S5_REPORT and submitReport). The report itself is teaching material and lives in
 * content (`stage5IncidentReport`); the segment indices into it are what the client sends back
 * as "masked".
 *
 * `pii: true` must be blacked out, `pii: false` must not be (IDs, wards, dates and
 * temperatures are not personal information on their own), and a segment without `pii`
 * is plain text that cannot be clicked.
 */

/**
 * `missing`: a pii segment is left visible. `over`: a non-pii segment is blacked out.
 * Both are reported together so a team does not learn the second one only after fixing
 * the first. The report text itself is never part of the result.
 */
export type S5ReportJudgement =
  | { outcome: "pass" }
  | { outcome: "reject"; missing: boolean; over: boolean };

/**
 * Judges the blacked-out report (submitReport). Indices outside the report, and
 * plain-text segments, are ignored as in the mock. Rejections are free and unlimited.
 */
export const judgeS5Report = (maskedIndices: readonly number[]): S5ReportJudgement => {
  const masked = new Set(maskedIndices);
  const missing = stage5IncidentReport.some((segment, i) => segment.pii === true && !masked.has(i));
  const over = stage5IncidentReport.some((segment, i) => segment.pii === false && masked.has(i));
  return missing || over ? { outcome: "reject", missing, over } : { outcome: "pass" };
};
