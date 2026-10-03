/**
 * The penalty's clock (mock startPenaltyClock): the time paid so far as mm:ss, counting up. A
 * penalty ends when its work is done, not when a time runs out, so it never counts down.
 */
export const penaltyClockText = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
};
