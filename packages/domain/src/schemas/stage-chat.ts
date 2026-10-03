import { z } from "zod";

import { stage1MailIdSchema } from "../stages/s1.js";
import { CHAT_MESSAGE_MAX_CHARS, chatThreadIdSchema } from "./chat.js";
import { commandIdSchema, resetGenerationSchema } from "./team-state.js";

/**
 * The AI chat bound to the stage the team is in (Issue #236). The screen names neither the
 * thread nor the system prompt: the server picks both from the game state, so a stale tab or a
 * hand-made request cannot talk to the Stage 3 AI without its trap, or write into another
 * stage's conversation. The older `send-message` (with `threadId` and `promptProfile`) stays
 * for the mock.
 */

const commandBase = { commandId: commandIdSchema, generation: resetGenerationSchema };

/**
 * The context box of Stage 1 holds the pasted handover memo (a little over 1,000 characters).
 * The server cuts it to fit one chat message; this ceiling only keeps the body bounded.
 */
const STAGE1_DRAFT_CONTEXT_MAX_CHARS = 8_000;

export const stageChatCommandSchema = z.discriminatedUnion("type", [
  // A message to the AI pane of the current stage.
  z
    .object({
      type: z.literal("stage-message"),
      ...commandBase,
      text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
    })
    .strict(),
  // [AIに下書きさせる] of Stage 1. The server checks the gate and builds the request itself.
  z
    .object({
      type: z.literal("s1-draft"),
      ...commandBase,
      mailId: stage1MailIdSchema,
      context: z.string().max(STAGE1_DRAFT_CONTEXT_MAX_CHARS),
      point: z.string().max(CHAT_MESSAGE_MAX_CHARS),
    })
    .strict(),
]);

export type StageChatCommand = z.infer<typeof stageChatCommandSchema>;

/** Asks the server again to prepare the current stage's conversation (Issue #85). */
export const prepareStageThreadCommandSchema = z
  .object({ type: z.literal("prepare-stage-thread"), generation: resetGenerationSchema })
  .strict();

/**
 * The AI of the current stage, as `GET /api/teams/:code/game` shows it.
 * - none: the stage has no AI (Prologue, Final).
 * - ready: the conversation to show is `threadId`, and only that one. `live` says whether the
 *   server sends messages to the AI in this stage (Stage 2 and Stage 6 answer on the screen).
 * - failed: the stage's conversation could not be prepared. The screen says so and offers to
 *   retry — it must not keep showing the previous stage's conversation (Issue #85).
 */
export const stageAiSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }).strict(),
  z
    .object({ status: z.literal("ready"), threadId: chatThreadIdSchema, live: z.boolean() })
    .strict(),
  z.object({ status: z.literal("failed") }).strict(),
]);

export type StageAi = z.infer<typeof stageAiSchema>;
