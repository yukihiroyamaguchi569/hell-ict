import { describe, expect, it } from "vitest";

import { initialTeamGameState } from "../../src/game/team-game.js";
import { gameCommandResponseSchema, gameViewResponseSchema } from "../../src/schemas/game-api.js";
import { gameInstantSchema } from "../../src/schemas/game.js";

const AT = "2026-10-31T01:00:00.000Z";

/** The state as the Worker's `gameView` shows it: without D1's processed command ids. */
const viewState = () => {
  const { game, ...rest } = initialTeamGameState(gameInstantSchema.parse(AT));
  const { processedCommandIds, ...shownGame } = game;
  void processedCommandIds;
  return { ...rest, game: shownGame };
};

const view = (overrides: Record<string, unknown> = {}) => ({
  state: viewState(),
  pos: 0,
  serverNow: Date.parse(AT),
  ai: { status: "none" },
  ...overrides,
});

describe("gameViewResponseSchema", () => {
  it("accepts the view of a new game", () => {
    expect(gameViewResponseSchema.safeParse(view()).success).toBe(true);
  });

  it("accepts pos at both ends of the band (0 and 7)", () => {
    expect(gameViewResponseSchema.safeParse(view({ pos: 0 })).success).toBe(true);
    expect(gameViewResponseSchema.safeParse(view({ pos: 7 })).success).toBe(true);
  });

  it.each([-1, 8, 1.5])("rejects pos %s", (pos) => {
    expect(gameViewResponseSchema.safeParse(view({ pos })).success).toBe(false);
  });

  it("rejects a state that still carries processedCommandIds (the view leaves them out)", () => {
    const state = viewState();
    const withIds = { ...state, game: { ...state.game, processedCommandIds: [] } };
    expect(gameViewResponseSchema.safeParse(view({ state: withIds })).success).toBe(false);
  });

  it("rejects a body without the stage AI or the server clock", () => {
    const { ai, serverNow, ...rest } = view();
    void ai;
    void serverNow;
    expect(gameViewResponseSchema.safeParse({ ...rest, serverNow: Date.parse(AT) }).success).toBe(
      false,
    );
    expect(gameViewResponseSchema.safeParse({ ...rest, ai: { status: "none" } }).success).toBe(
      false,
    );
  });

  it("rejects a negative server clock and an unknown field", () => {
    expect(gameViewResponseSchema.safeParse(view({ serverNow: -1 })).success).toBe(false);
    expect(gameViewResponseSchema.safeParse(view({ revision: 3 })).success).toBe(false);
  });

  it("checks the shape only: a state the server would refuse to store still parses", () => {
    // Stage 6 log out of step (one prompt, no candidate): teamGameStateSchema refuses it.
    const state = { ...viewState(), s6: { promptLog: ["a"], candidates: [] } };
    expect(gameViewResponseSchema.safeParse(view({ state })).success).toBe(true);
  });
});

describe("gameCommandResponseSchema", () => {
  const cleared = { type: "stage-cleared", stage: "prologue", at: AT };

  it("accepts applied with its events and judgement", () => {
    const body = { status: "applied", events: [cleared], judgement: null, ...view() };
    expect(gameCommandResponseSchema.safeParse(body).success).toBe(true);
  });

  it("accepts rejected with a known reason", () => {
    const body = { status: "rejected", reason: "stage-mismatch", judgement: null, ...view() };
    expect(gameCommandResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects rejected with an unknown reason", () => {
    const body = { status: "rejected", reason: "because", judgement: null, ...view() };
    expect(gameCommandResponseSchema.safeParse(body).success).toBe(false);
  });

  it("accepts duplicate with what the first application did", () => {
    const body = {
      status: "duplicate",
      original: { events: [cleared], judgement: { field: "ppe" } },
      ...view(),
    };
    expect(gameCommandResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects duplicate without original, and an unknown status", () => {
    expect(gameCommandResponseSchema.safeParse({ status: "duplicate", ...view() }).success).toBe(
      false,
    );
    expect(
      gameCommandResponseSchema.safeParse({ status: "conflict", judgement: null, ...view() })
        .success,
    ).toBe(false);
  });

  it("rejects applied without the view of the state", () => {
    const body = { status: "applied", events: [], judgement: null };
    expect(gameCommandResponseSchema.safeParse(body).success).toBe(false);
  });
});
