export { externalMessageSchema, parseExternalMessage } from "./schemas/external-message.js";
export type { ExternalMessage } from "./schemas/external-message.js";
export {
  commandIdSchema,
  commandResultSchema,
  leaderboardSnapshotSchema,
  teamCodeSchema,
  teamCommandSchema,
  teamSnapshotSchema,
} from "./schemas/team-state.js";
export type {
  CommandResult,
  LeaderboardSnapshot,
  TeamCode,
  TeamCommand,
  TeamSnapshot,
  TeamState,
} from "./schemas/team-state.js";
export { initialTeamSnapshot, initialTeamState, transitionTeam } from "./team-state.js";
export {
  chatCommandSchema,
  chatMessageResultSchema,
  chatMessageSchema,
  chatSnapshotSchema,
  chatThreadSchema,
  createThreadCommandSchema,
  createThreadResultSchema,
  sendMessageCommandSchema,
} from "./schemas/chat.js";
export type {
  ChatCommand,
  ChatMessage,
  ChatMessageId,
  ChatMessageResult,
  ChatRole,
  ChatSnapshot,
  ChatThread,
  ChatThreadId,
  CreateThreadCommand,
  CreateThreadResult,
  SendMessageCommand,
} from "./schemas/chat.js";
export { appendMessage, createThread, initialChatSnapshot } from "./chat.js";
export type { ChatMutationResult } from "./chat.js";
export {
  openAiChatCompletionSchema,
  parseOpenAiChatCompletion,
} from "./schemas/openai-response.js";
export type { OpenAiChatCompletion } from "./schemas/openai-response.js";
export { teamSyncMessageSchema } from "./schemas/sync.js";
export type { TeamSyncMessage } from "./schemas/sync.js";
export { httpErrorSchema } from "./schemas/http-error.js";
export type { HttpError } from "./schemas/http-error.js";
export { detectPii, piiPatterns, stage4Patient } from "./pii.js";
export type { PiiLabel } from "./pii.js";
export type { AiGateway, AiMessage, AiRequest, AiResponse } from "./ports/ai-gateway.js";
