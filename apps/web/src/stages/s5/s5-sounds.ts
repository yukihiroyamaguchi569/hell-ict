import type { Tone } from "../../ports.js";

/*
 * Stage 5's synthesized sounds (Issue #29), the same sine beeps as Stage 2's verdict ticks
 * (verdict-ticks.ts): no sound file, and the frame's mute and first-click rules apply.
 */

/** One press on a word of the report: a short, quiet tick (it plays a dozen times or more). */
export const REDACT_CLICK_TONE: Tone = { frequencyHz: 1_320, durationMs: 35, volume: 0.08 };

/** One note of a chime, `atMs` after it starts. */
export interface ChimeNote {
  readonly atMs: number;
  readonly tone: Tone;
}

/**
 * The report went through: two rising notes, kept modest (the penalty is paid, not won). As
 * quiet as Stage 2's ticks, and over in a quarter of a second.
 */
export const REDACT_DONE_CHIME: readonly ChimeNote[] = [
  { atMs: 0, tone: { frequencyHz: 1_319, durationMs: 90, volume: 0.1 } },
  { atMs: 110, tone: { frequencyHz: 1_760, durationMs: 150, volume: 0.1 } },
];

/**
 * The PII gate kept a message from the AI: one low tone. Not lower than a laptop's speakers
 * can play (they lose most of what is under 150 Hz).
 */
export const PII_BLOCK_TONE: Tone = { frequencyHz: 196, durationMs: 320, volume: 0.22 };
