// The goal's pure part: the confetti's pieces (mock goalConfettiBurst).

/** Five colours that stay visible on the goal's bright backing (mock GOAL_CONFETTI_COLORS). */
export const CONFETTI_COLORS = ["#c1121f", "#b8631f", "#2f8f7f", "#e0673f", "#8a4a72"] as const;
export const CONFETTI_COUNT = 64;
/** The burst is taken away this long after it starts, every piece fallen or not (mock). */
export const CONFETTI_CLEAR_MS = 3_400;
const DELAY_MAX_MS = 300;
const DURATION_MIN_MS = 1_800;
const DURATION_SPAN_MS = 1_200;
const ROT_MIN_DEG = 180;
const ROT_SPAN_DEG = 540;
const DRIFT_MAX_PX = 60;

export interface ConfettiPiece {
  readonly leftPct: number;
  readonly color: string;
  readonly delayMs: number;
  readonly durationMs: number;
  readonly rotDeg: number;
  readonly driftPx: number;
}

/**
 * A number in [0, 1) that looks random but depends only on the piece and the property: the burst
 * is the same every time, so no source of randomness has to be injected.
 */
const unit = (index: number, salt: number): number => {
  let x = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 2 ** 32;
};

const piece = (index: number): ConfettiPiece => ({
  leftPct: unit(index, 0) * 100,
  color: CONFETTI_COLORS[index % CONFETTI_COLORS.length] ?? CONFETTI_COLORS[0],
  delayMs: unit(index, 1) * DELAY_MAX_MS,
  durationMs: DURATION_MIN_MS + unit(index, 2) * DURATION_SPAN_MS,
  rotDeg: ROT_MIN_DEG + unit(index, 3) * ROT_SPAN_DEG,
  driftPx: (unit(index, 4) * 2 - 1) * DRIFT_MAX_PX,
});

/** The pieces of one burst: each falls once and is gone by DELAY_MAX_MS + the longest fall. */
export const confettiPieces = (count: number = CONFETTI_COUNT): readonly ConfettiPiece[] =>
  Array.from({ length: count }, (_, index) => piece(index));
