import { gameCommandResponseSchema, gameInstantSchema } from "@hell-ict/domain";
import type { PenaltyStatus, TeamGameViewState } from "@hell-ict/domain";

import type { SendOutcome } from "../../../src/composables/use-game-session.js";
import { START_MS, viewBody } from "../../fakes.js";

/** When the team entered Stage 5 in these fixtures. */
export const ENTERED_MS = START_MS + 90 * 60_000;
export const ENTERED = gameInstantSchema.parse(new Date(ENTERED_MS).toISOString());

/** A team on Stage 5 as `GET /game` shows it. */
export const s5State = (
  penalty: PenaltyStatus = "none",
  { cleared = false, entered = ENTERED }: { cleared?: boolean; entered?: string } = {},
): TeamGameViewState => {
  const { state } = viewBody(5);
  const at = gameInstantSchema.parse(new Date(START_MS).toISOString());
  const done = { prologue: at, s1: at, s2: at, s3: at, s4: at };
  return {
    ...state,
    game: {
      ...state.game,
      stage: "s5",
      clearedAt: cleared ? { ...done, s5: at } : done,
      penalties: { s3: "done", s5: penalty },
    },
    enteredAt: { s1: at, s2: at, s3: at, s4: at, s5: gameInstantSchema.parse(entered) },
  };
};

/** The Worker's answer to a Stage 5 command, checked by the schema the screen reads it with. */
export const answer = (fields: Record<string, unknown>, state = s5State()): SendOutcome => ({
  kind: "done",
  response: gameCommandResponseSchema.parse({
    ...(fields.status === undefined ? { status: "applied", events: [] } : {}),
    ...(fields.status === "duplicate" ? {} : { judgement: null }),
    state,
    pos: 5,
    serverNow: ENTERED_MS,
    ai: { status: "none" },
    ...fields,
  }),
});
