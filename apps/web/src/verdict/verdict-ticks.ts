import type { Tone } from "../ports.js";

/*
 * When a pass's checks and its line of success come in under the verdict, and the beep each one
 * makes. `VerdictBox` delays each row's fade-in by `verdictTickDelayMs`, and Stage 2 schedules
 * the beeps from the same numbers, so the sound and the row cannot drift apart.
 */

/** The first check row starts to show this long after the verdict. */
export const VERDICT_TICK_FIRST_MS = 200;
/** Each following row (and the line of success) comes this much later. */
export const VERDICT_TICK_STEP_MS = 400;

/** When row `index` (0 = the first check; the line of success follows the last) starts to show. */
export const verdictTickDelayMs = (index: number): number =>
  VERDICT_TICK_FIRST_MS + index * VERDICT_TICK_STEP_MS;

/**
 * Every check beeps the same short sine (B5), quieter than the sound effects so the unlock sound
 * of the clear that follows stands out.
 */
export const VERDICT_CHECK_TONE: Tone = { frequencyHz: 988, durationMs: 70, volume: 0.12 };
/** The line of success beeps higher (A6) and a little longer. The unlock follows 0.6 s later. */
export const VERDICT_DONE_TONE: Tone = { frequencyHz: 1760, durationMs: 90, volume: 0.12 };

export interface VerdictTick {
  readonly atMs: number;
  readonly tone: Tone;
}

/**
 * The beeps for a pass with `count` checks: one per check row and one for the line of success,
 * each as its row starts to show.
 */
export const verdictTicks = (count: number): readonly VerdictTick[] => {
  const checks = Math.max(0, count);
  return [
    ...Array.from({ length: checks }, (_, index) => ({
      atMs: verdictTickDelayMs(index),
      tone: VERDICT_CHECK_TONE,
    })),
    { atMs: verdictTickDelayMs(checks), tone: VERDICT_DONE_TONE },
  ];
};
