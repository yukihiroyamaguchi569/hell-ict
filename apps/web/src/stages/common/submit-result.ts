import type { GameCommandResponse } from "@hell-ict/domain";

import type { SendOutcome } from "../../composables/use-game-session.js";

/*
 * What a submission that someone may send back came to (Stage 4's summary and action, Stage 6's
 * poster). Each stage says only whose words a sent-back judgement turns into.
 */

/**
 * - sent-back: it is sent back with `line` (the box turns to the warning colour).
 * - accepted: it went through; the state that came with the answer says what follows.
 * - retry: it is not known to have arrived; pressing again resends it under the same commandId.
 * - none: nothing to say (a stale tab, the team has moved on).
 */
export type SubmitResult =
  | { readonly kind: "sent-back"; readonly line: string }
  | { readonly kind: "accepted" | "retry" | "none" };

/** A resend of an applied command brings the first judgement back as `original`. */
export const judgementOf = (response: GameCommandResponse): unknown =>
  response.status === "duplicate" ? response.original.judgement : response.judgement;

export const submitResult = (
  outcome: SendOutcome,
  sentBackLine: (judgement: unknown) => string | null,
): SubmitResult => {
  if (outcome.kind === "unavailable" || outcome.kind === "failed") return { kind: "retry" };
  if (outcome.kind !== "done") return { kind: "none" };
  const line = sentBackLine(judgementOf(outcome.response));
  if (line !== null) return { kind: "sent-back", line };
  // Refused for another reason (stage-mismatch, already-cleared): the new state tells.
  return outcome.response.status === "rejected" ? { kind: "none" } : { kind: "accepted" };
};
