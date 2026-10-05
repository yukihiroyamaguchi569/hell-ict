import {
  stage3KarubeAfterTrap,
  stage3KarubeFinalPush,
  stage3KarubeLines,
  stage3KarubeTypeHint,
} from "@hell-ict/content";
import { stage3TrapHintOfJudgement } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";

import type { KarubeCall } from "../stage-module.js";

/*
 * What 苅部さん says in Stage 3 (the mock's s3NudgeKarube, called from runStage3Verdict and
 * finishPenalty, index.html 7760-7790 and 7975-7996, plus the #219 hints). Pure: the calls follow
 * from the state, so a reload finds the same ones and the phone does not ring them again. The ids
 * carry the stay's entry time, so a game master's reset, after which the team enters again, rings
 * them again.
 *
 * - lines (S3_KARUBE_LINES): once per stay, at whichever comes first of the first rejection for a
 *   short field and the end of the penalty.
 * - after-trap (S3_KARUBE_AFTER_TRAP): at the end of the penalty, when the lines had come before
 *   it (the mock appends it to a phone that already speaks; else the lines are what he says).
 * - #219: the 2nd and 3rd trap judgements bring the type hint, the 4th the final push, later ones
 *   nothing. They replace the mock's after-trap line on a repeated trap.
 */

const call = (entered: string, name: string, lines: readonly string[]): KarubeCall => ({
  callId: `s3:${entered}:${name}`,
  lines,
});

const hintCall = (entered: string, judgement: number): KarubeCall | null => {
  switch (stage3TrapHintOfJudgement(judgement)) {
    case "type-hint":
      return call(entered, `type-hint:${String(judgement)}`, stage3KarubeTypeHint);
    case "final-push":
      return call(entered, `final-push:${String(judgement)}`, stage3KarubeFinalPush);
    case "none":
      return null;
  }
};

/** The hints of the trap judgements so far, oldest first. */
const hintCalls = (entered: string, trapJudgements: number): readonly KarubeCall[] =>
  Array.from({ length: trapJudgements }, (_, i) => hintCall(entered, i + 1)).filter(
    (hint) => hint !== null,
  );

/** The penalty is paid and its window has closed on this screen. */
const penaltyOver = (state: TeamGameViewState, penaltyHeld: boolean): boolean =>
  state.game.penalties.s3 === "done" && !penaltyHeld;

/**
 * The calls that should have rung by now, oldest first. `rejectedIn` is the entry time of the
 * stay in which a short field was sent back before the trap fired (kept in sessionStorage: the
 * server does not keep rejections), or `null`. `penaltyHeld`: the paid penalty's window is still
 * up with 「罰ゲーム完了！」, and the end of the penalty rings only once it has closed.
 */
export const stage3KarubeCalls = (
  state: TeamGameViewState,
  rejectedIn: string | null,
  penaltyHeld = false,
): readonly KarubeCall[] => {
  const entered = state.enteredAt.s3;
  if (state.game.stage !== "s3" || entered === undefined) return [];
  const rejected = rejectedIn === entered;
  const penaltyDone = penaltyOver(state, penaltyHeld);
  const calls: KarubeCall[] = [];
  if (rejected || penaltyDone) calls.push(call(entered, "lines", stage3KarubeLines));
  if (rejected && penaltyDone) calls.push(call(entered, "after-trap", [stage3KarubeAfterTrap]));
  return [...calls, ...hintCalls(entered, state.s3.trapJudgements)];
};
