/*
 * Overlays cover the whole screen, header included, and only one is up at a time: two veils on
 * top of each other leave the team unsure which one to answer. When several are wanted at once,
 * the most important one wins; the others wait underneath and come back when it goes.
 *
 * - stale: this tab is older than the game master's reset. Nothing else may be answered here,
 *   least of all a clear effect whose last button writes `advance`.
 * - opening: the hospital and the loading bar before the entry screen (Issue #379), while the
 *   game's assets load. Only on a first visit, so it never stands over a game.
 * - entry: no team on screen (joining, a restore under way or failed).
 * - clear: a stage's clear effect (①〜④).
 * - stage: a window of the stage on screen (Stage 1's result, Stage 3's penalty, Stage 4's
 *   director). One layer for all of them: the stage decides which of its windows to draw. It
 *   waits under the clear effect, which carries the team on to the next stage. A window that
 *   must come before the effect holds it back instead (`StageInstance.holdClear`).
 * - viewer: a document the team opened to read. The least urgent: it waits under anything the
 *   game itself puts up, and is still open when that goes.
 */
export const OVERLAY_PRIORITY = ["stale", "opening", "entry", "clear", "stage", "viewer"] as const;

export type OverlayId = (typeof OVERLAY_PRIORITY)[number];

export const pickOverlay = (requested: readonly OverlayId[]): OverlayId | null =>
  OVERLAY_PRIORITY.find((overlay) => requested.includes(overlay)) ?? null;
