import { z } from "zod";

import { commandIdSchema, revisionSchema, teamCodeSchema } from "./team-state.js";

export const chatThreadIdSchema = z.uuid();
export const chatMessageIdSchema = z.uuid();
export const chatRoleSchema = z.enum(["user", "assistant"]);

export const chatMessageSchema = z
  .object({
    messageId: chatMessageIdSchema,
    role: chatRoleSchema,
    text: z.string().trim().min(1).max(4000),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const chatThreadSchema = z
  .object({
    threadId: chatThreadIdSchema,
    title: z.string().trim().min(1).max(40),
    messages: z.array(chatMessageSchema),
  })
  .strict();

export const chatSnapshotSchema = z
  .object({
    teamCode: teamCodeSchema,
    revision: revisionSchema,
    threads: z.array(chatThreadSchema).min(1),
  })
  .strict();

export const createThreadCommandSchema = z
  .object({
    type: z.literal("create-thread"),
    commandId: commandIdSchema,
    title: z.string().trim().min(1).max(40),
  })
  .strict();

export const sendMessageCommandSchema = z
  .object({
    type: z.literal("send-message"),
    commandId: commandIdSchema,
    threadId: chatThreadIdSchema,
    text: z.string().trim().min(1).max(4000),
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
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatThread = z.infer<typeof chatThreadSchema>;
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;
export type CreateThreadCommand = z.infer<typeof createThreadCommandSchema>;
export type SendMessageCommand = z.infer<typeof sendMessageCommandSchema>;
export type ChatCommand = z.infer<typeof chatCommandSchema>;
export type ChatMessageResult = z.infer<typeof chatMessageResultSchema>;
export type CreateThreadResult = z.infer<typeof createThreadResultSchema>;
