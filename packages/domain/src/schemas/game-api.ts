import { z } from "zod";

import { epochMsSchema } from "../stages/deadline.js";
import { gameEventSchema, gameStagePosition } from "./game.js";
import { stageAiSchema } from "./stage-chat.js";
import {
  teamGameJudgementSchema,
  teamGameRejectionReasonSchema,
  teamGameViewStateSchema,
} from "./team-game.js";

/**
 * What the screen receives from the game API (Issue #234, #238). The Worker builds these bodies
 * in `apps/worker/src/game-api.ts` (`gameView`, `replyBody`); a Worker test checks that its
 * output passes these schemas, so the two cannot drift apart silently.
 */

const gameViewFields = {
  state: teamGameViewStateSchema,
  /** The stop on the race band (the mock's `pos`, 0〜7). */
  pos: z.number().int().min(0).max(gameStagePosition("final")),
  /** The server's clock when it answered: the screen aligns its countdowns to it. */
  serverNow: epochMsSchema,
  /** The AI of the current stage: the only conversation the screen shows. */
  ai: stageAiSchema,
};

/** `GET /api/teams/:code/game` (and `POST .../game/chat/thread`). */
export const gameViewResponseSchema = z.object(gameViewFields).strict();

export type GameViewResponse = z.infer<typeof gameViewResponseSchema>;

/**
 * `POST /api/teams/:code/game/commands`. Always 200 with the state as it is now:
 * - applied: the command changed the state; `events` are what happened (a clear, a trap …).
 * - rejected: nothing changed; `reason` says why.
 * - duplicate: the same commandId came again; `original` is what its first application did.
 */
export const gameCommandResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      events: z.array(gameEventSchema),
      judgement: teamGameJudgementSchema,
      ...gameViewFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: teamGameRejectionReasonSchema,
      judgement: teamGameJudgementSchema,
      ...gameViewFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("duplicate"),
      original: z
        .object({ events: z.array(gameEventSchema), judgement: teamGameJudgementSchema })
        .strict(),
      ...gameViewFields,
    })
    .strict(),
]);

export type GameCommandResponse = z.infer<typeof gameCommandResponseSchema>;
