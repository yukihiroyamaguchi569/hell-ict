import { stage4KarubeFinalPush, stage4KarubeWhoHint } from "@hell-ict/content";
import { stage4ActionHint } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";

import type { KarubeCall } from "../stage-module.js";

/*
 * What 苅部さん says in Stage 4 (Issue #38): after the director has sent the action back for the
 * 3rd time, who to ask; after the 5th, where to read and whom to have it checked by. Pure: the
 * calls follow from the server's count, so a reload finds the same ones and the phone does not
 * ring them again. The ids carry the stay's entry time, so a game master's reset, after which the
 * team enters again, rings them again.
 */

const call = (entered: string, name: string, lines: readonly string[]): KarubeCall => ({
  callId: `s4:${entered}:${name}`,
  lines,
});

const hintCall = (entered: string, reject: number): KarubeCall | null => {
  switch (stage4ActionHint(reject)) {
    case "who-hint":
      return call(entered, `who-hint:${String(reject)}`, stage4KarubeWhoHint);
    case "final-push":
      return call(entered, `final-push:${String(reject)}`, stage4KarubeFinalPush);
    case "none":
      return null;
  }
};

/** The calls that should have rung by now, oldest first. */
export const stage4KarubeCalls = (state: TeamGameViewState): readonly KarubeCall[] => {
  const entered = state.enteredAt.s4;
  if (state.game.stage !== "s4" || entered === undefined) return [];
  return Array.from({ length: state.s4.actionRejects }, (_, i) => hintCall(entered, i + 1)).filter(
    (hint) => hint !== null,
  );
};
