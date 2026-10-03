// The goal's pure part: the confetti's pieces (mock goalConfettiBurst) and the row of stops
// with the team's marker (mock .goal-track, placeMark).

/** The stops of the race, Prologue to Final (mock .goal-track .stops). */
export const GOAL_STOPS = ["Prologue", "S1", "S2", "S3", "S4", "S5", "S6", "Final"] as const;

/** The goal only comes up in Final, so the team's marker always stands on the last stop. */
export const GOAL_STOP = GOAL_STOPS.length - 1;

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

export type MarkAlign = "start" | "center" | "end";

/**
 * Where a marker stands on the row of stops: the stops are spread edge to edge, so stop `pos` is at
 * pos ÷ (stops − 1). A marker on either end is pulled inwards so the team's name is not cut off
 * at the edge of the screen (mock placeMark).
 */
export const stopMark = (pos: number): { readonly leftPct: number; readonly align: MarkAlign } => {
  const last = GOAL_STOPS.length - 1;
  const align: MarkAlign = pos <= 0 ? "start" : pos >= last ? "end" : "center";
  return { leftPct: (pos * 100) / last, align };
};
