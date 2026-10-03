import { gameViewResponseSchema, teamCodeSchema } from "@hell-ict/domain";
import type {
  GameCommandResponse,
  GameStageId,
  Stage1State,
  TeamCode,
  TeamGameCommand,
} from "@hell-ict/domain";
import { FakeClock } from "@hell-ict/domain/fakes";
import { computed, shallowRef } from "vue";

import { useServerClock } from "../../../src/composables/use-server-clock.js";
import type {
  GameCommandInput,
  GameSession,
  GameView,
  SendOutcome,
} from "../../../src/composables/use-game-session.js";
import { START_MS, viewBody } from "../../fakes.js";

export const T0 = START_MS;
export const TEAM: TeamCode = teamCodeSchema.parse("123456");

export const stage1 = (patch: Partial<Stage1State> = {}): Stage1State => ({
  stageStartedAt: T0,
  round: 1,
  roundStartedAt: T0,
  r3Try: 0,
  doneIds: [],
  curt: [],
  memoReplied: false,
  status: { phase: "playing" },
  ...patch,
});

/** The view of a team in `stage` with this Stage 1 state. */
export const viewIn = (s1: Stage1State | null, stage: GameStageId = "s1"): GameView => {
  const body = viewBody(2);
  return gameViewResponseSchema.parse({
    ...body,
    state: {
      ...body.state,
      game: { ...body.state.game, stage },
      enteredAt: { s1: new Date(T0).toISOString() },
      s1,
    },
  });
};

/** What the server answers to a command: the response, or an outcome without one. */
export type Answer = (command: GameCommandInput) => SendOutcome | Promise<SendOutcome>;

export const rejectedWith = (
  reason: Extract<GameCommandResponse, { status: "rejected" }>["reason"],
  view: GameView,
): SendOutcome => ({
  kind: "done",
  response: { status: "rejected", reason, judgement: null, ...view },
});

export const appliedWith = (view: GameView): SendOutcome => ({
  kind: "done",
  response: { status: "applied", events: [], judgement: null, ...view },
});

/**
 * A game session that answers with `answer` and records what was sent. Only what a stage uses is
 * real; the rest does nothing.
 */
export const fakeSession = (initial: GameView | null, answer: Answer) => {
  const view = shallowRef<GameView | null>(initial);
  const sent: GameCommandInput[] = [];
  const commandIds: (string | undefined)[] = [];
  let ids = 0;
  let refreshes = 0;
  let staled = false;
  const session: GameSession = {
    status: computed(() => (staled ? "stale" : "ready")),
    teamCode: computed(() => TEAM),
    generation: computed(() => 3),
    view: computed(() => view.value),
    serverClock: useServerClock(new FakeClock(new Date(T0))),
    hasSavedTeam: () => true,
    start: () => Promise.resolve("none"),
    join: () => Promise.resolve("ok"),
    retry: () => Promise.resolve("none"),
    async send(command, commandId) {
      sent.push(command);
      commandIds.push(commandId);
      const outcome = await answer(command);
      if (outcome.kind === "done") view.value = outcome.response;
      return outcome;
    },
    newCommandId: () => `cmd-${String(++ids)}`,
    prepareStageThread: () => Promise.resolve("done"),
    markStale: () => {
      staled = true;
    },
    currentJoin: () => 1,
    onEvents: () => () => undefined,
    refresh: () => {
      refreshes += 1;
      return Promise.resolve();
    },
    dispose: () => undefined,
  };
  return {
    session,
    view,
    sent,
    commandIds,
    types: (): TeamGameCommand["type"][] => sent.map((command) => command.type),
    refreshes: () => refreshes,
    isStale: () => staled,
  };
};
