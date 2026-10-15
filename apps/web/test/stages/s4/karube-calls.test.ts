import { stage4KarubeFinalPush, stage4KarubeWhoHint } from "@hell-ict/content";
import { gameInstantSchema } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { stage4KarubeCalls } from "../../../src/stages/s4/karube-calls.js";
import { START_MS, viewBody } from "../../fakes.js";

const at = (ms: number) => gameInstantSchema.parse(new Date(ms).toISOString());
const ENTERED = at(START_MS + 60_000);
/** The entry time of another stay (a game master's reset, and the team entered again). */
const OTHER_STAY = at(START_MS + 120_000);

/** A team on Stage 4 whose action has been sent back `actionRejects` times. */
const s4State = (actionRejects: number, entered = ENTERED): TeamGameViewState => {
  const { state } = viewBody(5);
  return {
    ...state,
    game: { ...state.game, stage: "s4" },
    enteredAt: { s4: entered },
    s4: { summaryAccepted: true, actionRejects },
  };
};

const names = (calls: readonly { callId: string }[]) =>
  calls.map((call) => call.callId.replace(`s4:${ENTERED}:`, ""));

describe("stage4KarubeCalls（#38）", () => {
  it.each([
    [0, []],
    [1, []],
    [2, []],
    [3, ["who-hint:3"]],
    [4, ["who-hint:3"]],
    [5, ["who-hint:3", "final-push:5"]],
    [6, ["who-hint:3", "final-push:5"]],
    [7, ["who-hint:3", "final-push:5"]],
  ] as const)("差し戻し %i 回: %j（古い順に残り、6回目以降は増えない）", (count, expected) => {
    expect(names(stage4KarubeCalls(s4State(count)))).toEqual(expected);
  });

  it("who-hint と final-push は content の台詞", () => {
    const calls = stage4KarubeCalls(s4State(5));
    expect(calls.map((call) => call.lines)).toEqual([stage4KarubeWhoHint, stage4KarubeFinalPush]);
  });

  it("S4 にいない・入室時刻が無いときは何も言わない", () => {
    const moved = s4State(5);
    expect(stage4KarubeCalls({ ...moved, game: { ...moved.game, stage: "s5" } })).toEqual([]);
    expect(stage4KarubeCalls({ ...s4State(5), enteredAt: {} })).toEqual([]);
  });

  it("callId は滞在ごとに変わる（リセット後の再入室でもう一度鳴る）", () => {
    expect(stage4KarubeCalls(s4State(3, OTHER_STAY))[0]?.callId).toBe(
      `s4:${OTHER_STAY}:who-hint:3`,
    );
  });
});
