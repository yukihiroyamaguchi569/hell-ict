import { stage5IncidentReport } from "@hell-ict/content";

/** The incident report's segment indices, grouped by their blacking-out flag. */
const indicesWhere = (predicate: (pii: boolean | undefined) => boolean): number[] =>
  stage5IncidentReport.flatMap((segment, i) => (predicate(segment.pii) ? [i] : []));

/** Segments that must be blacked out. */
export const piiIndices = indicesWhere((pii) => pii === true);
/** Segments that look personal but must not be blacked out. */
export const nonPiiIndices = indicesWhere((pii) => pii === false);
/** Segments that cannot be blacked out at all (plain text). */
export const plainIndices = indicesWhere((pii) => pii === undefined);
