export { externalMessageSchema, parseExternalMessage } from "./schemas/external-message.js";
export type { ExternalMessage } from "./schemas/external-message.js";
export {
  commandIdSchema,
  commandResultSchema,
  enterStage1CommandSchema,
  leaderboardSnapshotSchema,
  stage1EmailIdSchema,
  stage1ReplySchema,
  stage1StateSchema,
  stageSchema,
  submitStage1ReplyCommandSchema,
  teamCodeSchema,
  teamCommandSchema,
  teamSnapshotSchema,
} from "./schemas/team-state.js";
export type {
  CommandResult,
  EnterStage1Command,
  LeaderboardEntry,
  LeaderboardSnapshot,
  Stage,
  Stage1EmailId,
  Stage1Reply,
  Stage1State,
  SubmitStage1ReplyCommand,
  TeamCode,
  TeamCommand,
  TeamSnapshot,
  TeamState,
} from "./schemas/team-state.js";
export { initialTeamSnapshot, initialTeamState, transitionTeam } from "./team-state.js";
export type { TransitionResult } from "./team-state.js";
export {
  isStage1Round1Complete,
  judgeStage1Reply,
  stage1EmailStatus,
  stage1Round1Tally,
  STAGE1_MIN_REPLY_LENGTH,
  STAGE1_POLITE_PATTERN,
  STAGE1_ROUND1_DEADLINE_MS,
  STAGE1_ROUND1_EMAILS,
} from "./stage1.js";
export type { Stage1Email, Stage1EmailStatus, Stage1Round1Tally } from "./stage1.js";
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
export { httpErrorCodeSchema, httpErrorSchema } from "./schemas/http-error.js";
export type { HttpError, HttpErrorCode } from "./schemas/http-error.js";
export { detectPii, piiPatterns, stage4Patient } from "./pii.js";
export type { PiiLabel } from "./pii.js";
export type { AiGateway, AiMessage, AiRequest, AiResponse } from "./ports/ai-gateway.js";
