export { externalMessageSchema, parseExternalMessage } from "./schemas/external-message.js";
export type { ExternalMessage } from "./schemas/external-message.js";
export {
  commandIdSchema,
  commandResultSchema,
  leaderboardEntrySchema,
  leaderboardSnapshotSchema,
  resetGenerationSchema,
  revisionSchema,
  sessionResultSchema,
  teamCodeSchema,
  teamCommandSchema,
  teamSnapshotSchema,
} from "./schemas/team-state.js";
export type {
  CommandResult,
  LeaderboardSnapshot,
  SessionResult,
  TeamCode,
  TeamCommand,
  TeamSnapshot,
  TeamState,
} from "./schemas/team-state.js";
export { initialTeamSnapshot, initialTeamState, transitionTeam } from "./team-state.js";
export {
  CHAT_MESSAGE_MAX_CHARS,
  chatCommandSchema,
  chatMessageResultSchema,
  chatMessageSchema,
  chatSnapshotSchema,
  chatThreadIdSchema,
  chatThreadKindSchema,
  chatThreadSchema,
  commandStatusSchema,
  createThreadCommandSchema,
  createThreadResultSchema,
  promptProfileSchema,
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
  ChatThreadKind,
  CommandStatus,
  CreateThreadCommand,
  CreateThreadResult,
  PromptProfile,
  SendMessageCommand,
} from "./schemas/chat.js";
export {
  appendMessage,
  chatCommandFingerprint,
  countThreadsOfKind,
  createThread,
  initialChatSnapshot,
  normalizeAssistantText,
  redactChatMessageResultPii,
  redactSnapshotPii,
} from "./chat.js";
export type { ChatMutationResult } from "./chat.js";
export {
  forgetPending,
  forgetPiiPending,
  mergePending,
  parseStoredPending,
  PENDING_COMMAND_LIMIT,
  PENDING_QUERY_LIMIT,
  pendingIdFor,
  pendingKey,
  pendingQueryIds,
  reconcilePending,
  storedPendingText,
} from "./chat/pending-commands.js";
export type { PendingCommands } from "./chat/pending-commands.js";
export {
  checkpointFingerprint,
  createThreadFingerprint,
  publicTeamId,
  sha256Hex,
  stableStringify,
} from "./fingerprint.js";
export {
  CHECKPOINT_DATA_MAX_BYTES,
  CHECKPOINT_DATA_MAX_DEPTH,
  CHECKPOINT_DATA_TOO_LARGE_MESSAGE,
  CHECKPOINT_ELAPSED_MAX_MS,
  CHECKPOINT_IDS_VERSION,
  CHECKPOINT_REJECTION_REASONS,
  checkpointBodySchema,
  checkpointRejectionReasonSchema,
  checkpointSnapshotSchema,
  checkpointStateSchema,
  checkpointTrapSchema,
  saveCheckpointCommandSchema,
  saveCheckpointResultSchema,
} from "./schemas/checkpoint.js";
export type {
  CheckpointBody,
  CheckpointRejectionReason,
  CheckpointSnapshot,
  CheckpointState,
  CheckpointTrap,
  SaveCheckpointCommand,
  SaveCheckpointResult,
} from "./schemas/checkpoint.js";
export { applyCheckpoint, mergeCheckpoint } from "./checkpoint.js";
export type { CheckpointResult } from "./checkpoint.js";
export {
  openAiChatCompletionSchema,
  openAiErrorBodySchema,
  parseOpenAiChatCompletion,
  parseOpenAiErrorBody,
} from "./schemas/openai-response.js";
export type { OpenAiChatCompletion, OpenAiErrorIdentifiers } from "./schemas/openai-response.js";
export { teamSyncMessageSchema } from "./schemas/sync.js";
export type { TeamSyncMessage } from "./schemas/sync.js";
export { httpErrorCodeSchema, httpErrorSchema } from "./schemas/http-error.js";
export type { HttpError, HttpErrorCode } from "./schemas/http-error.js";
export {
  containsPii,
  detectPii,
  PII_REDACTION,
  piiPatterns,
  redactPii,
  stage5Patient,
} from "./pii.js";
export type { PiiLabel } from "./pii.js";
export {
  DEADLINE_GRACE_MS,
  epochMsSchema,
  estimateServerOffsetMs,
  isPastDeadline,
  remainingMs,
  secondsToMs,
  toServerTime,
} from "./stages/deadline.js";
export type { ClockSample } from "./stages/deadline.js";
export {
  INBOX_LIMIT_MS,
  INBOX_MAIL_IDS,
  INBOX_REPLY_REJECT_REASONS,
  inboxDeadlineAt,
  inboxMailIdSchema,
  inboxMailStatus,
  inboxStateSchema,
  judgePrologue,
  resumeInbox,
  sendInboxReply,
  startInbox,
} from "./stages/inbox.js";
export type {
  InboxMailId,
  InboxMailStatus,
  InboxReplyJudgement,
  InboxReplyRejectReason,
  InboxReplyResult,
  InboxState,
  PrologueJudgement,
} from "./stages/inbox.js";
export {
  acknowledgeStage1RoundResult,
  isCurtReply,
  judgeStage1,
  judgeStage1DraftRequest,
  sendStage1MemoReply,
  sendStage1Reply,
  settleStage1Round,
  STAGE1_CLEAR_RESULTS,
  STAGE1_MAIL_IDS,
  STAGE1_MIN_REPLY_LENGTH,
  STAGE1_REPLY_LIMIT_MS,
  STAGE1_REPLY_REJECT_REASONS,
  STAGE1_ROUND_FAILURES,
  STAGE1_ROUNDS,
  STAGE1_SCHEDULES,
  stage1AttemptNo,
  stage1FirstFailureCause,
  stage1MailIdSchema,
  stage1Mails,
  stage1MemoDeadlineAt,
  stage1MemoStatus,
  stage1RoundSchema,
  stage1RoundSummary,
  stage1SettleAt,
  stage1StateSchema,
  startStage1,
} from "./stages/s1.js";
export type {
  Stage1DraftJudgement,
  Stage1Judgement,
  Stage1Mail,
  Stage1MailId,
  Stage1MailStatus,
  Stage1ReplyJudgement,
  Stage1ReplyRejectReason,
  Stage1ReplyResult,
  Stage1Round,
  Stage1RoundSummary,
  Stage1Settlement,
  Stage1State,
} from "./stages/s1.js";
export {
  isStage2AddendumLanded,
  isStage2AddendumTaken,
  isStage2AiUnlocked,
  judgeStage2,
  STAGE2_ADDENDUM_ROW_COUNT,
  STAGE2_AI_UNLOCK_DELAY_MS,
  STAGE2_BASE_ROW_COUNT,
  STAGE2_CHECK_IDS,
  STAGE2_DEADLINE_MS,
  stage2AcceptedRowCounts,
  stage2DeadlineAt,
  stage2ExpectedRowCount,
  stage2ScriptedTable,
  stage2SecondsLeft,
  stage2StateSchema,
  startStage2,
  resetStage2Grid,
  takeStage2Addendum,
} from "./stages/s2.js";
export type {
  Stage2Cell,
  Stage2CheckId,
  Stage2Judgement,
  Stage2State,
  Stage2TakeJudgement,
} from "./stages/s2.js";
export {
  normalizeStage2Rows,
  parseCsv,
  parseStage2Table,
  readStage2TableForGrid,
  STAGE2_COLUMNS,
  stage2GridSchema,
  stage2RowSchema,
  toIsoDate,
} from "./stages/s2-table.js";
export type {
  Stage2Grid,
  Stage2Row,
  Stage2TableError,
  Stage2TableParse,
} from "./stages/s2-table.js";
export { VIEW_IDS, viewIdSchema } from "./schemas/view.js";
export type { ViewId } from "./schemas/view.js";
export {
  normalizeLegacyCheckpointBody,
  normalizeLegacyCheckpointCommand,
  normalizeLegacyCheckpointSnapshot,
  normalizeLegacyViewField,
  normalizeLegacyViewId,
} from "./legacy-ids.js";
export type { AiGateway, AiMessage, AiRequest, AiResponse } from "./ports/ai-gateway.js";
export {
  advanceCommandSchema,
  completePenaltyCommandSchema,
  GAME_REJECTION_REASONS,
  GAME_STAGE_IDS,
  gameCommandSchema,
  gameEventSchema,
  gameInstantSchema,
  gameRejectionReasonSchema,
  gameStageIdSchema,
  gameStagePosition,
  gameStateSchema,
  gameVerdictSchema,
  JUDGED_STAGE_IDS,
  judgedStageIdSchema,
  PENALTY_STATUSES,
  penaltyStatusSchema,
  recordJudgementCommandSchema,
  stageJudgementSchema,
  TRAP_STAGE_IDS,
  trapStageIdSchema,
} from "./schemas/game.js";
export type {
  AdvanceCommand,
  CompletePenaltyCommand,
  GameCommand,
  GameEvent,
  GameInstant,
  GameRejectionReason,
  GameStageId,
  GameState,
  GameVerdict,
  JudgedStageId,
  PenaltyStatus,
  RecordJudgementCommand,
  StageJudgement,
  TrapStageId,
} from "./schemas/game.js";
export { applyGameCommand, initialGameState } from "./game/apply-game-command.js";
export type { GameCommandResult } from "./game/apply-game-command.js";
export {
  judgeStage3,
  STAGE3_FIELD_IDS,
  stage3FieldIdSchema,
  stage3SubmissionSchema,
} from "./stages/s3.js";
export type { Stage3FieldId, Stage3Judgement, Stage3Submission } from "./stages/s3.js";
export {
  judgeStage4Action,
  judgeStage4Summary,
  STAGE4_ACTION_REJECT_REASONS,
} from "./stages/s4.js";
export type {
  Stage4ActionJudgement,
  Stage4ActionRejectReason,
  Stage4SummaryJudgement,
} from "./stages/s4.js";
export { judgeS5AiMessage, judgeS5Submission, S5_FEVER_IDS } from "./stages/s5.js";
export type {
  S5FeverId,
  S5FormatRejectReason,
  S5GateJudgement,
  S5SubmissionJudgement,
} from "./stages/s5.js";
export { judgeS5Report } from "./stages/s5-report.js";
export type { S5ReportJudgement } from "./stages/s5-report.js";
export { STAGE5_DEADLINE_MS, stage5DeadlineAt } from "./stages/s5.js";
export {
  isS6PromptCopiedFromMail,
  judgeS6Submission,
  S6_MAIL_PARAGRAPHS,
  S6_POSTER_TYPES,
  selectS6PosterType,
} from "./stages/s6.js";
export type { S6PosterType, S6RejectReason, S6SubmissionJudgement } from "./stages/s6.js";
export { toStageJudgement } from "./stages/stage-judgement.js";
export type { S5RejectReason } from "./stages/s5.js";
export {
  TEAM_GAME_REJECTION_REASONS,
  teamGameCommandSchema,
  teamGameJudgementSchema,
  teamGameOutcomeSchema,
  teamGameRejectionReasonSchema,
  teamGameStandingSchema,
  teamGameStateSchema,
  teamGameViewStateSchema,
} from "./schemas/team-game.js";
export type {
  TeamGameCommand,
  TeamGameCommandType,
  TeamGameOutcome,
  TeamGameRejectionReason,
  TeamGameStanding,
  TeamGameState,
  TeamGameViewState,
} from "./schemas/team-game.js";
export { gameCommandResponseSchema, gameViewResponseSchema } from "./schemas/game-api.js";
export type { GameCommandResponse, GameViewResponse } from "./schemas/game-api.js";
export {
  applyTeamGameCommand,
  initialTeamGameState,
  teamGameLatestMs,
  teamGamePosition,
  teamGameStanding,
} from "./game/team-game.js";
export type { TeamGameNow, TeamGameResult } from "./game/team-game.js";
export { HANDOVER_STAGE_IDS, teamGameScene } from "./game/scene.js";
export type { PlayedStageId, SceneFacts, TeamGameScene, TeamGameSceneKind } from "./game/scene.js";
export {
  countStage3TrapJudgements,
  STAGE3_TRAP_HINTS,
  stage3TrapHint,
  stage3TrapHintOfJudgement,
  stage3TrapHintSchema,
} from "./stages/s3.js";
export type { Stage3TrapHint } from "./stages/s3.js";
export {
  prepareStageThreadCommandSchema,
  stageAiSchema,
  stageChatCommandSchema,
} from "./schemas/stage-chat.js";
export type { StageAi, StageChatCommand } from "./schemas/stage-chat.js";
export {
  resolveStageChatTarget,
  stageAiPlan,
  stageAiView,
  stageChatText,
  stageThreadTitle,
} from "./game/stage-ai.js";
export type { StageAiPlan, StageChatTarget, StageChatText } from "./game/stage-ai.js";
export { buildStage1DraftText } from "./stages/s1-draft.js";
export type { Stage1DraftInput } from "./stages/s1-draft.js";
export { shouldHintStage1Round3Retry, STAGE1_ROUND3_HINT_FROM_TRY } from "./stages/s1.js";
export { inboxSettleAt } from "./stages/inbox.js";
