import { chatMessageResultSchema } from "@hell-ict/domain";
import type { ChatMessageResult, StageChatCommand, TeamCode } from "@hell-ict/domain";

import { requestJson } from "../../api/http.js";
import type { ApiResult } from "../../api/http.js";
import type { Clock, HttpPort } from "../../ports.js";

/** [AIに下書きさせる]: the mail, the context box and the key points. The server builds the rest. */
export type Stage1DraftCommand = Extract<StageChatCommand, { type: "s1-draft" }>;

/**
 * `POST /api/teams/:code/game/chat/messages` with `type: "s1-draft"`: the stage's AI route, so the
 * server checks the draft gate and picks the thread and the prompt. Idempotent by its commandId.
 * Read the result with `classifyDraftSend`. `clock` reads a 429's `Retry-After` given as a date.
 */
export const sendStage1Draft = (
  http: HttpPort,
  clock: Clock,
  teamCode: TeamCode,
  command: Stage1DraftCommand,
): Promise<ApiResult<ChatMessageResult>> =>
  requestJson(
    http,
    { method: "POST", path: `/api/teams/${teamCode}/game/chat/messages`, body: command },
    chatMessageResultSchema,
    clock,
  );
