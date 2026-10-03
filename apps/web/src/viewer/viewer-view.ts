import {
  viewerCopyFailedLabel,
  viewerDocs,
  type ViewerId,
  type ViewerTable,
} from "@hell-ict/content";

/*
 * What the attachment viewer shows for a document (mock openViewer, renderViewerCols,
 * selectedColumnsText). Pure: ViewerOverlay only draws what this returns.
 */

export const VIEWER_LABELS = {
  copy: "コピー",
  copied: "コピーしました",
  copyFailed: viewerCopyFailedLabel,
  close: "閉じる",
  columnsHeading: "コピーする列",
  copyColumns: "選んだ列をコピー",
  noColumns: "列を1つ以上選んでください",
} as const;

/** How long "コピーしました" (or its failure) stays on a button (mock: 1400 ms). */
export const COPIED_MS = 1_400;
/** How long the "pick a column" warning stays on the column button (mock: 1600 ms). */
export const NO_COLUMNS_MS = 1_600;

export interface ViewerSheet {
  readonly name: string;
  readonly text: string;
  /** Prose wraps; tab-separated sheets keep `white-space: pre` so their columns stay aligned. */
  readonly wrap: boolean;
  /**
   * Last year's notice (s6notice) has no [コピー]: it is a bad example to read, not material to
   * hand to the AI. Every other document copies, s5list included — copying it whole is the trap.
   */
  readonly copyable: boolean;
  /** Documents with a table offer column-picked copying (today only s5list). */
  readonly table: ViewerTable | null;
}

const UNCOPYABLE: ReadonlySet<ViewerId> = new Set<ViewerId>(["s6notice"]);

export const viewerSheet = (id: ViewerId): ViewerSheet => {
  const doc: { name: string; text: string; wrap?: boolean; table?: ViewerTable } = viewerDocs[id];
  return {
    name: doc.name,
    text: doc.text,
    wrap: doc.wrap === true,
    copyable: !UNCOPYABLE.has(id),
    table: doc.table ?? null,
  };
};

/**
 * The columns picked when a document opens: all of them, every time. Remembering a column taken
 * off earlier would let the next reader hand over a table with a hole in it while believing it
 * whole; and "copy everything" must stay the shortest way, or the Stage 5 trap dies.
 */
export const allColumnsPicked = (table: ViewerTable | null): readonly boolean[] =>
  table === null ? [] : table.header.map(() => true);

/** `picked` with column `index` flipped. An index outside the columns changes nothing. */
export const toggleColumn = (picked: readonly boolean[], index: number): readonly boolean[] =>
  picked.map((on, i) => (i === index ? !on : on));

/**
 * The picked columns as tab-separated text, header row first, in the table's column order.
 * `null` when no column is picked: the caller says why instead of copying nothing.
 */
export const selectedColumnsText = (
  table: ViewerTable,
  picked: readonly boolean[],
): string | null => {
  const columns = table.header.map((_, i) => i).filter((i) => picked[i] === true);
  if (columns.length === 0) return null;
  const pick = (row: readonly string[]): string => columns.map((i) => row[i] ?? "").join("\t");
  return [pick(table.header), ...table.rows.map(pick)].join("\n");
};
