import { z } from "zod";

/**
 * Deadlines of the timed stages (Prologue inbox, Stage 1, Stage 2), judged on the server's clock.
 *
 * All instants here are epoch milliseconds, and every function takes `now` instead of reading a
 * clock, so a test can walk time forward with a plain list of numbers.
 *
 * The mock judged deadlines on the browser's own clock, so a reply sent just before the deadline
 * always made it. On the server the same reply arrives a little later, so the server accepts it
 * for `DEADLINE_GRACE_MS` after the nominal deadline (Issue #232). The screen still counts down
 * to the nominal deadline, using the server's time estimated with `estimateServerOffsetMs`, so a
 * team never sees the extra two seconds; they only absorb the network delay.
 */
export const DEADLINE_GRACE_MS = 2_000;

/** An instant on the server's clock, as epoch milliseconds. */
export const epochMsSchema = z.number().int().nonnegative();

/** Seconds to milliseconds, for the mock's constants that are written in seconds. */
export const secondsToMs = (seconds: number): number => seconds * 1_000;

/**
 * The deadline is over for good: nothing sent from now on can have been sent in time. `>=`
 * matches the mock's `limit - elapsed > 0` test for "still open" (inbox, handover memo).
 */
export const isPastDeadline = (deadlineAt: number, now: number): boolean =>
  now >= deadlineAt + DEADLINE_GRACE_MS;

/** Time left until the nominal deadline, for the countdown on screen. Never negative. */
export const remainingMs = (deadlineAt: number, now: number): number =>
  Math.max(0, deadlineAt - now);

export interface ClockSample {
  /** The client's clock when the request left. */
  requestSentAt: number;
  /** The client's clock when the response arrived. */
  responseReceivedAt: number;
  /** The server's clock written into the response. */
  serverNow: number;
}

/**
 * How far the server's clock is ahead of the client's (negative when behind). The server read
 * its clock somewhere during the round trip; the midpoint is the best guess without more samples.
 */
export const estimateServerOffsetMs = (sample: ClockSample): number =>
  sample.serverNow - (sample.requestSentAt + sample.responseReceivedAt) / 2;

/** The server's time now, estimated from the client's clock and the last measured offset. */
export const toServerTime = (clientNow: number, offsetMs: number): number => clientNow + offsetMs;
