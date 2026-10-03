import {
  gameCommandResponseSchema,
  gameInstantSchema,
  type TeamGameViewState,
} from "@hell-ict/domain";
import type { PenaltyStatus } from "@hell-ict/domain";

import type { SendOutcome } from "../../../src/composables/use-game-session.js";
import { START_MS, viewBody } from "../../fakes.js";

/** When the team entered Stage 3 in these fixtures. */
export const ENTERED_MS = START_MS + 60 * 60_000;

/** A team on Stage 3 as `GET /game` shows it, with the Stage 3 penalty in `penalty`. */
export const s3State = (penalty: PenaltyStatus = "none"): TeamGameViewState => {
  const { state } = viewBody(3);
  const at = (ms: number) => gameInstantSchema.parse(new Date(ms).toISOString());
  return {
    ...state,
    game: {
      ...state.game,
      stage: "s3",
      clearedAt: { prologue: at(START_MS), s1: at(START_MS), s2: at(START_MS) },
      penalties: { s3: penalty, s5: "none" },
    },
    enteredAt: { s1: at(START_MS), s2: at(START_MS), s3: at(ENTERED_MS) },
    s3: { trapJudgements: penalty === "none" ? 0 : 1 },
  };
};

type Event = "stage-cleared" | "submission-rejected" | "trap-triggered" | "trap-repeated";

/** The Worker's answer to a Stage 3 command, checked by the schema the screen reads it with. */
export const applied = (
  judgement: unknown,
  events: readonly Event[],
  state: TeamGameViewState = s3State(),
): SendOutcome => ({
  kind: "done",
  response: gameCommandResponseSchema.parse({
    status: "applied",
    events: events.map((type) => ({ type, stage: "s3", at: new Date(ENTERED_MS).toISOString() })),
    judgement,
    state,
    pos: 3,
    serverNow: ENTERED_MS,
    ai: { status: "none" },
  }),
});
