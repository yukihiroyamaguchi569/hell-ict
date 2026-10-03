import { gameInstantSchema, gameViewResponseSchema } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { isWelcome, raceElapsedMs, shellFacts } from "../../src/shell/shell-view.js";
import { START_MS, viewBody } from "../fakes.js";

const AT = gameInstantSchema.parse(new Date(START_MS).toISOString());
const BASE = gameViewResponseSchema.parse(viewBody(0)).state;
const OPENED = { openedAt: START_MS, sent: [] };

const withGame = (
  game: Partial<TeamGameViewState["game"]>,
  rest: Partial<TeamGameViewState> = {},
): TeamGameViewState => ({ ...BASE, ...rest, game: { ...BASE.game, ...game } });

describe("shellFacts", () => {
  it("始めたばかりのチームは Prologue・未クリア・受信トレイ未開封", () => {
    expect(shellFacts(BASE, null)).toEqual({
      stage: "prologue",
      cleared: false,
      s3Penalty: "none",
      inboxOpened: false,
      rightOverride: null,
    });
  });

  it("ステージが渡した右ペインの上書きをそのまま持つ", () => {
    expect(shellFacts(BASE, "shown").rightOverride).toBe("shown");
  });

  it("受信トレイを開いたら inboxOpened", () => {
    expect(shellFacts({ ...BASE, inbox: OPENED }, null).inboxOpened).toBe(true);
  });

  it("今のステージのクリアだけを cleared と読む（前のステージのクリアは数えない）", () => {
    expect(
      shellFacts(withGame({ stage: "s2", clearedAt: { prologue: AT, s1: AT } }), null).cleared,
    ).toBe(false);
    expect(
      shellFacts(withGame({ stage: "s2", clearedAt: { prologue: AT, s1: AT, s2: AT } }), null)
        .cleared,
    ).toBe(true);
  });

  it("Final はクリアの概念が無いので cleared にならない", () => {
    expect(shellFacts(withGame({ stage: "final" }), null).cleared).toBe(false);
  });

  it("Stage 3 の罰の状態をそのまま渡す", () => {
    expect(
      shellFacts(withGame({ stage: "s3", penalties: { s3: "in-progress", s5: "none" } }), null)
        .s3Penalty,
    ).toBe("in-progress");
  });
});

describe("isWelcome", () => {
  it("Prologue で受信トレイを開く前だけがウェルカム", () => {
    expect(isWelcome(BASE)).toBe(true);
    expect(isWelcome({ ...BASE, inbox: OPENED })).toBe(false);
    expect(isWelcome(withGame({ stage: "s1" }))).toBe(false);
  });
});

describe("raceElapsedMs（レースの時計はStage 1のブリーフィングを了解した瞬間から）", () => {
  const S1: NonNullable<TeamGameViewState["s1"]> = {
    stageStartedAt: START_MS + 60_000,
    round: 1,
    roundStartedAt: START_MS + 60_000,
    r3Try: 0,
    doneIds: [],
    curt: [],
    memoReplied: false,
    status: { phase: "playing" },
  };

  it("入室・ウェルカム・受信トレイ・ブリーフィング中は止まっている", () => {
    expect(raceElapsedMs(BASE, START_MS + 999_999)).toBeNull();
    expect(raceElapsedMs({ ...BASE, inbox: OPENED }, START_MS)).toBeNull();
    expect(raceElapsedMs(withGame({ stage: "s1" }), START_MS)).toBeNull();
  });

  it("了解した後はサーバの時計でそこからの経過", () => {
    const started = withGame({ stage: "s1" }, { s1: S1 });
    expect(raceElapsedMs(started, S1.stageStartedAt)).toBe(0);
    expect(raceElapsedMs(started, S1.stageStartedAt + 61_500)).toBe(61_500);
  });

  it("先のステージでも Final でも同じ起点で進み続ける", () => {
    expect(raceElapsedMs(withGame({ stage: "s4" }, { s1: S1 }), S1.stageStartedAt + 10_000)).toBe(
      10_000,
    );
    expect(
      raceElapsedMs(withGame({ stage: "final" }, { s1: S1 }), S1.stageStartedAt + 20_000),
    ).toBe(20_000);
  });
});
