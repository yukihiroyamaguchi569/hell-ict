import {
  stage1KarubeContext,
  stage1KarubeManual,
  stage1KarubeRound1Curt,
  stage1KarubeRound1Miss,
  stage1KarubeRound3Again,
  stage1KarubeRound3Hint,
} from "@hell-ict/content";
import { STAGE1_ROUND3_HINT_FROM_TRY, STAGE1_SCHEDULES } from "@hell-ict/domain";
import type { Stage1State } from "@hell-ict/domain";

import type { KarubeCall } from "../stage-module.js";

/*
 * What 苅部さん says in Stage 1 (the mock's phsS1Lines, set in s1DeliverAIAndRetry,
 * s1StartRound3, s1RetryRound3 and s1Result, plus the #222 hint). Pure: the call follows from
 * the state, so a reload finds the same call and the phone does not ring it again (the phone
 * rings each callId once). The ids carry the stage's start, so a game master's reset, which
 * starts the stage over, rings them again.
 */

/** What made R1 fail, as recorded when its result window came up. */
export type Stage1FirstFailureCause = "curt" | "missed";

/** The first R3 attempt whose again-voice is `stage1KarubeRound3Again[0]`. */
const FIRST_RETRY_TRY = 2;

const call = (state: Stage1State, name: string, lines: readonly string[]): KarubeCall => ({
  callId: `s1:${String(state.stageStartedAt)}:${name}`,
  lines,
});

/** A reply of this R3 attempt went out (an R3 retry takes the R3 mails out of `doneIds`). */
const repliedThisAttempt = (state: Stage1State): boolean =>
  STAGE1_SCHEDULES[3].some((mail) => state.doneIds.includes(mail.id));

/** What the attempt opens with: the context advice first, then one shorter voice per retry. */
const round3OpeningCall = (state: Stage1State): KarubeCall | null => {
  if (state.r3Try < FIRST_RETRY_TRY) return call(state, "context", stage1KarubeContext);
  const again = stage1KarubeRound3Again[state.r3Try - FIRST_RETRY_TRY];
  return again === undefined ? null : call(state, `again:${String(state.r3Try)}`, again);
};

/**
 * The attempt earned the #222 hint: from r3Try 3 on, once its first reply went out. Unlike
 * `shouldHintStage1Round3Retry` (asked while the round runs), the hint stays through the
 * attempt's result window, so a reload there still finds a hint that rang but was not opened
 * (the phone does not ring a read one again). A cleared stage has nothing left to hint.
 */
const earnedRound3Hint = (state: Stage1State): boolean =>
  state.status.phase !== "cleared" &&
  state.r3Try >= STAGE1_ROUND3_HINT_FROM_TRY &&
  repliedThisAttempt(state);

/**
 * R3: the context advice on the first attempt, then one shorter voice per retry until they run
 * out (r3Try 2–4); from r3Try 3 on, the #222 hint as well once the attempt's first reply is out
 * (r3Try 3–4 ring both). The hint does not look at the context box. Each attempt has its own
 * ids, so each rings once.
 */
const round3Calls = (state: Stage1State): readonly KarubeCall[] => {
  const opening = round3OpeningCall(state);
  const calls = opening === null ? [] : [opening];
  if (!earnedRound3Hint(state)) return calls;
  return [...calls, call(state, `hint:${String(state.r3Try)}`, stage1KarubeRound3Hint)];
};

/**
 * The calls that should have rung by now, oldest first (empty when he has nothing to say).
 * `firstFailure` is R1's cause (kept in sessionStorage: the state no longer shows it once R2
 * starts); without it he opens with the missed mails.
 */
export const stage1KarubeCalls = (
  state: Stage1State,
  firstFailure: Stage1FirstFailureCause | null,
): readonly KarubeCall[] => {
  switch (state.round) {
    case 1:
      // R1 cleared by hand: the punch line. A failed R1 speaks only once R2 starts.
      return state.status.phase === "cleared" ? [call(state, "manual", [stage1KarubeManual])] : [];
    case 2:
      return [
        call(
          state,
          "round1",
          firstFailure === "curt" ? stage1KarubeRound1Curt : stage1KarubeRound1Miss,
        ),
      ];
    case 3:
      return round3Calls(state);
  }
};
