import { z } from "zod";

import { commandIdSchema, revisionSchema, teamCodeSchema } from "./team-state.js";

export const chatThreadIdSchema = z.uuid();
export const chatMessageIdSchema = z.uuid();
export const chatRoleSchema = z.enum(["user", "assistant"]);

/** 1メッセージの本文長の上限。OpenAI応答の切り詰めもこの値へ揃える。 */
export const CHAT_MESSAGE_MAX_CHARS = 4000;

export const chatMessageSchema = z
  .object({
    messageId: chatMessageIdSchema,
    role: chatRoleSchema,
    text: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
    createdAt: z.iso.datetime(),
  })
  .strict();

/**
 * スレッドの出どころ。ステージ進行が自動で開くもの（stage）と、参加者が足すもの
 * （manual）を分けて数えるために持つ——上限を1本にすると、手動スレッドを作りすぎた
 * チームがステージ進行そのものを止めてしまう。
 */
export const chatThreadKindSchema = z.enum(["stage", "manual"]);

export const chatThreadSchema = z
  .object({
    threadId: chatThreadIdSchema,
    title: z.string().trim().min(1).max(40),
    // kindを持たないスレッド（この列を足す前に作られたもの）はmanualとして数える。
    kind: chatThreadKindSchema.optional(),
    messages: z.array(chatMessageSchema),
  })
  .strict();

/**
 * 送信コマンドの状態。台帳に残っている位置がそのまま状態になる——
 * processed_message_commandsにあれば完了、pending_message_commandsにあれば処理中、
 * どちらにも無ければサーバが知らない（届いていない・猶予期間を過ぎて掃除された）。
 */
export const commandStatusSchema = z.enum(["pending", "processed", "unknown"]);

export const chatSnapshotSchema = z
  .object({
    teamCode: teamCodeSchema,
    revision: revisionSchema,
    threads: z.array(chatThreadSchema).min(1),
    /**
     * 問い合わせたcommandIdの状態。再入室したクライアントが「未確定として持っている
     * IDのうち、もう完了しているのはどれか」をID単位で確かめるための枠であり、
     * 履歴の本文や並びからは原理的に区別できない（同じ文面を打ち直したときや、
     * 先に送った要求が後から完了したときに取り違える）。問い合わせなかった呼び出しでは
     * このキー自体を持たない。DOのchat_stateへ保存する対象ではない。
     */
    commands: z.record(commandIdSchema, commandStatusSchema).optional(),
  })
  .strict();

export const createThreadCommandSchema = z
  .object({
    type: z.literal("create-thread"),
    commandId: commandIdSchema,
    title: z.string().trim().min(1).max(40),
    // 既存クライアントはkindを送らない。参加者の手動追加として扱う。
    kind: chatThreadKindSchema.default("manual"),
  })
  .strict();

// ステージ別のシステムプロンプトを切り替えるための識別子。省略時はWorker側で
// "default"として扱う（企画書§5、Stage 1/3のシステムプロンプト注入設計）。
export const promptProfileSchema = z.enum(["default", "s1", "s3"]);

export const sendMessageCommandSchema = z
  .object({
    type: z.literal("send-message"),
    commandId: commandIdSchema,
    threadId: chatThreadIdSchema,
    text: z.string().trim().min(1).max(4000),
    promptProfile: promptProfileSchema.optional(),
  })
  .strict();

export const chatCommandSchema = z.discriminatedUnion("type", [
  createThreadCommandSchema,
  sendMessageCommandSchema,
]);

export const chatMessageResultSchema = z
  .object({
    snapshot: chatSnapshotSchema,
    assistant: chatMessageSchema,
  })
  .strict();

export const createThreadResultSchema = z
  .object({
    snapshot: chatSnapshotSchema,
  })
  .strict();

export type ChatThreadId = z.infer<typeof chatThreadIdSchema>;
export type ChatMessageId = z.infer<typeof chatMessageIdSchema>;
export type ChatRole = z.infer<typeof chatRoleSchema>;
export type PromptProfile = z.infer<typeof promptProfileSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatThread = z.infer<typeof chatThreadSchema>;
export type ChatThreadKind = z.infer<typeof chatThreadKindSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type CommandStatus = z.infer<typeof commandStatusSchema>;
export type CreateThreadCommand = z.infer<typeof createThreadCommandSchema>;
export type SendMessageCommand = z.infer<typeof sendMessageCommandSchema>;
export type ChatCommand = z.infer<typeof chatCommandSchema>;
export type ChatMessageResult = z.infer<typeof chatMessageResultSchema>;
export type CreateThreadResult = z.infer<typeof createThreadResultSchema>;
