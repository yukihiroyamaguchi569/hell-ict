import { chatMessageResultSchema, chatSnapshotSchema } from "@hell-ict/domain";
import type { ChatMessageResult, ChatSnapshot, StageChatCommand, TeamCode } from "@hell-ict/domain";

import type { Clock, HttpPort } from "../ports.js";
import { requestJson } from "./http.js";
import type { ApiResult } from "./http.js";

/** A message to the AI of the stage the team is in. The server picks the thread and prompt. */
export type StageMessageCommand = Extract<StageChatCommand, { type: "stage-message" }>;

/** The chat routes of the Worker the stage's AI pane uses, one function per route. */
export interface ChatApi {
  /**
   * `GET /api/teams/:code/chat`: every thread of the team (past stages too: the screen shows only
   * the current stage's). With `commandIds`, also where each of them stands (processed, pending
   * or unknown), to settle the ids a reload left unconfirmed.
   */
  fetchChat(teamCode: TeamCode, commandIds?: readonly string[]): Promise<ApiResult<ChatSnapshot>>;
  /** `POST /api/teams/:code/game/chat/messages`: idempotent by its commandId. */
  sendStageMessage(
    teamCode: TeamCode,
    command: StageMessageCommand,
  ): Promise<ApiResult<ChatMessageResult>>;
}

const chatPath = (teamCode: TeamCode, commandIds: readonly string[] | undefined): string => {
  const path = `/api/teams/${teamCode}/chat`;
  if (commandIds === undefined || commandIds.length === 0) return path;
  return `${path}?${new URLSearchParams({ commandIds: commandIds.join(",") }).toString()}`;
};

/** `clock` reads a 429's `Retry-After` when it comes as a date. */
export const createChatApi = (http: HttpPort, clock: Clock): ChatApi => ({
  fetchChat: (teamCode, commandIds) =>
    requestJson(
      http,
      { method: "GET", path: chatPath(teamCode, commandIds) },
      chatSnapshotSchema,
      clock,
    ),
  sendStageMessage: (teamCode, command) =>
    requestJson(
      http,
      { method: "POST", path: `/api/teams/${teamCode}/game/chat/messages`, body: command },
      chatMessageResultSchema,
      clock,
    ),
});
