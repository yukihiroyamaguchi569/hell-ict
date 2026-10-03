import { stage2AddendumRows, stage2SheetRows } from "@hell-ict/content";
import type { Stage2Row } from "../../../src/stages/s2-table.js";

/**
 * The Stage 2 teaching material from packages/content (the mock's `S2_SHEET_ROWS` /
 * `S2_ADDENDUM_ROWS`). The domain takes the rows as input; these mutable copies only feed the
 * tests.
 */
export const SHEET_ROWS: Stage2Row[] = stage2SheetRows.map((row): Stage2Row => [...row]);

export const ADDENDUM_ROWS: Stage2Row[] = stage2AddendumRows.map((row): Stage2Row => [...row]);
