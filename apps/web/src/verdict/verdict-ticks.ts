import type { Tone } from "../ports.js";

/*
 * When a pass's checks come in under the verdict, and the beep each one makes. `VerdictBox`
 * delays each row's fade-in by `verdictTickDelayMs`, and Stage 2 schedules the beeps from the
 * same numbers, so the sound and the row cannot drift apart.
 */

/** The first check row starts to show this long after the verdict. */
export const VERDICT_TICK_FIRST_MS = 200;
/** Each following row (and the line of success) comes this much later. */
export const VERDICT_TICK_STEP_MS = 400;

/** When row `index` (0 = the first check) starts to show. */
export const verdictTickDelayMs = (index: number): number =>
  VERDICT_TICK_FIRST_MS + index * VERDICT_TICK_STEP_MS;

/**
 * One short sine beep per check, a step higher each time (A5, B5, C#6, E6), quieter than the
 * sound effects so the unlock sound of the clear that follows stands out. The line of success
 * has no beep: the unlock comes 0.6 s after it.
 */
export const VERDICT_TICK_FREQUENCIES_HZ = [880, 988, 1109, 1319] as const;
export const VERDICT_TICK_DURATION_MS = 70;
export const VERDICT_TICK_VOLUME = 0.12;

/** A pass with more checks than pitches stays on the top one. */
const LAST_FREQUENCY_HZ = VERDICT_TICK_FREQUENCIES_HZ[3];

export interface VerdictTick {
  readonly atMs: number;
  readonly tone: Tone;
}

/** The beeps for a pass with `count` checks: one per row, as it starts to show. */
export const verdictTicks = (count: number): readonly VerdictTick[] =>
  Array.from({ length: Math.max(0, count) }, (_, index) => ({
    atMs: verdictTickDelayMs(index),
    tone: {
      frequencyHz: VERDICT_TICK_FREQUENCIES_HZ[index] ?? LAST_FREQUENCY_HZ,
      durationMs: VERDICT_TICK_DURATION_MS,
      volume: VERDICT_TICK_VOLUME,
    },
  }));
