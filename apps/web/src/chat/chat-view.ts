import type { ChatMessage, ChatSnapshot, StageAi } from "@hell-ict/domain";

/*
 * What the AI pane shows, from the server's chat and the stage AI of `GET /game`. Pure: the
 * pane only draws what these return.
 */

/**
 * - none: the stage has no AI (Prologue, Final).
 * - live: messages go to the AI.
 * - scripted: the stage answers on the screen (Stage 2 and Stage 6); the pane does not send.
 * - failed: the stage's conversation could not be prepared; the pane offers to retry.
 */
export type ChatPaneMode = "none" | "live" | "scripted" | "failed";

export const chatPaneMode = (ai: StageAi): ChatPaneMode => {
  if (ai.status === "ready") return ai.live ? "live" : "scripted";
  return ai.status;
};

/**
 * The pane offers to prepare the conversation again only when it would talk to the server: a
 * stage that answers on the screen (`scripted`: Stage 2) never needs the server's conversation,
 * so its own conversation stays drawn and sendable even when that failed.
 */
export const showsPrepareFailure = (mode: ChatPaneMode, scripted: boolean): boolean =>
  mode === "failed" && !scripted;

/**
 * The messages of the current stage's conversation, and only those: the chat holds past stages
 * too, and the pane must never fall back to one of them (a missing thread shows as empty).
 */
export const stageThreadMessages = (
  snapshot: ChatSnapshot | null,
  ai: StageAi,
): readonly ChatMessage[] => {
  if (snapshot === null || ai.status !== "ready") return [];
  return snapshot.threads.find((thread) => thread.threadId === ai.threadId)?.messages ?? [];
};

/**
 * The chat to keep when an answer arrives: answers may come back out of order, so one older
 * than the chat on screen (a lower revision) is dropped. Another team's chat always replaces it.
 */
export const newerSnapshot = (current: ChatSnapshot | null, next: ChatSnapshot): ChatSnapshot => {
  if (current === null || current.teamCode !== next.teamCode) return next;
  return next.revision < current.revision ? current : next;
};

/**
 * A reply split for display (the mock's liveReplyHtml): from the first line holding a tab on,
 * the text is a table that keeps its tabs (drawn with `white-space: pre`, so that copying it
 * keeps the columns); the lines before it are the lead. A reply without a tab is all lead.
 */
export interface ReplyParts {
  readonly lead: readonly string[];
  readonly table: string | null;
}

export const replyParts = (text: string): ReplyParts => {
  const lines = text.split("\n");
  const tableAt = lines.findIndex((line) => line.includes("\t"));
  if (tableAt < 0) return { lead: lines, table: null };
  return { lead: lines.slice(0, tableAt), table: lines.slice(tableAt).join("\n") };
};
