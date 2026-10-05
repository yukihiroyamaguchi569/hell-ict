import {
  stage3KarubeAfterTrap,
  stage3KarubeFinalPush,
  stage3KarubeLines,
  stage3KarubeTypeHint,
} from "@hell-ict/content";
import { gameInstantSchema } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { stage3KarubeCalls } from "../../../src/stages/s3/karube-calls.js";
import { ENTERED_MS, s3State } from "./s3-fixtures.js";

const ENTERED = new Date(ENTERED_MS).toISOString();
/** The entry time of another stay (a game master's reset, and the team entered again). */
const OTHER_STAY = gameInstantSchema.parse(new Date(ENTERED_MS + 60_000).toISOString());

const withTraps = (trapJudgements: number): TeamGameViewState => ({
  ...s3State("done"),
  s3: { trapJudgements },
});

const names = (calls: readonly { callId: string }[]) =>
  calls.map((call) => call.callId.replace(`s3:${ENTERED}:`, ""));

describe("stage3KarubeCalls", () => {
  it("差し戻しも罠もまだなら何も言わない", () => {
    expect(stage3KarubeCalls(s3State(), null)).toEqual([]);
  });

  it("この滞在で差し戻しがあれば S3_KARUBE_LINES の2行", () => {
    expect(stage3KarubeCalls(s3State(), ENTERED)).toEqual([
      { callId: `s3:${ENTERED}:lines`, lines: stage3KarubeLines },
    ]);
  });

  it("別の滞在（リセット前）の差し戻しの記録は数えない", () => {
    expect(stage3KarubeCalls(s3State(), OTHER_STAY)).toEqual([]);
    expect(names(stage3KarubeCalls(s3State("done"), OTHER_STAY))).toEqual(["lines"]);
  });

  it("罰の間は、差し戻しが無ければまだ黙っている（差し戻し済みなら lines のまま）", () => {
    expect(stage3KarubeCalls(s3State("in-progress"), null)).toEqual([]);
    expect(names(stage3KarubeCalls(s3State("in-progress"), ENTERED))).toEqual(["lines"]);
  });

  it("罰明け: 差し戻しが無かったなら lines、あったなら lines に続けて S3_KARUBE_AFTER_TRAP", () => {
    expect(names(stage3KarubeCalls(s3State("done"), null))).toEqual(["lines"]);
    const calls = stage3KarubeCalls(s3State("done"), ENTERED);
    expect(names(calls)).toEqual(["lines", "after-trap"]);
    expect(calls[1]?.lines).toEqual([stage3KarubeAfterTrap]);
  });

  it("罰明けの完了表示の間（penaltyHeld）は、罰明けの電話をまだ鳴らさない", () => {
    expect(stage3KarubeCalls(s3State("done"), null, true)).toEqual([]);
    expect(names(stage3KarubeCalls(s3State("done"), ENTERED, true))).toEqual(["lines"]);
    expect(names(stage3KarubeCalls(s3State("done"), ENTERED, false))).toEqual([
      "lines",
      "after-trap",
    ]);
  });

  it.each([
    [1, ["lines"]],
    [2, ["lines", "type-hint:2"]],
    [3, ["lines", "type-hint:2", "type-hint:3"]],
    [4, ["lines", "type-hint:2", "type-hint:3", "final-push:4"]],
    [5, ["lines", "type-hint:2", "type-hint:3", "final-push:4"]],
  ] as const)("罠判定 %i 回: %j（古い順に残り、5回目以降は増えない）", (count, expected) => {
    expect(names(stage3KarubeCalls(withTraps(count), null))).toEqual(expected);
  });

  it("type-hint と final-push は content の台詞", () => {
    const calls = stage3KarubeCalls(withTraps(4), null);
    expect(calls[1]?.lines).toEqual(stage3KarubeTypeHint);
    expect(calls[3]?.lines).toEqual(stage3KarubeFinalPush);
  });

  it("S3 にいない・入室時刻が無いときは何も言わない", () => {
    const moved = { ...withTraps(4), game: { ...withTraps(4).game, stage: "s4" as const } };
    expect(stage3KarubeCalls(moved, ENTERED)).toEqual([]);
    const noEntry = { ...withTraps(4), enteredAt: {} };
    expect(stage3KarubeCalls(noEntry, ENTERED)).toEqual([]);
  });

  it("callId は滞在ごとに変わる（リセット後の再入室でもう一度鳴る）", () => {
    const again = { ...s3State("done"), enteredAt: { ...s3State().enteredAt, s3: OTHER_STAY } };
    expect(stage3KarubeCalls(again, null)[0]?.callId).toBe(`s3:${OTHER_STAY}:lines`);
  });
});
