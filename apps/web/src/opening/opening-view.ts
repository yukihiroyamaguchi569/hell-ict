import { opening } from "@hell-ict/content";

/*
 * What the opening shows and when (Issue #379). Pure: OpeningScreen.vue only draws it.
 */

/** Whole percent of the assets settled, rounded down so 100 means all of them. 100 for none. */
export const progressPercent = (settled: number, total: number): number => {
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, Math.floor((settled * 100) / total)));
};

/** 「読み込み中 60%」 */
export const loadingText = (percent: number): string => `${opening.loading} ${String(percent)}%`;

export interface OpeningFacts {
  /** A team was saved on this PC when the page opened: its restore runs instead. */
  readonly savedTeam: boolean;
  /** The preload is over (everything settled or the time limit passed). */
  readonly finished: boolean;
}

/**
 * Whether the opening covers the screen. Only on a first visit, before the entry screen: a reload
 * with a saved team goes straight back to its game (the race clock is running) and the assets load
 * behind it.
 */
export const openingWanted = (facts: OpeningFacts): boolean => !facts.savedTeam && !facts.finished;
