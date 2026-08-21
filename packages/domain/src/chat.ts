import type { ChatMessage, ChatSnapshot, ChatThreadId } from "./schemas/chat.js";
import type { TeamCode } from "./schemas/team-state.js";

export const initialChatSnapshot = (
  teamCode: TeamCode,
  mainThreadId: ChatThreadId,
): ChatSnapshot => ({
  teamCode,
  revision: 0,
  threads: [{ threadId: mainThreadId, title: "メイン", messages: [] }],
});

export type ChatMutationResult =
  | { ok: true; snapshot: ChatSnapshot }
  | { ok: false; reason: "unknown-thread" | "duplicate-thread" };

export const createThread = (
  snapshot: ChatSnapshot,
  params: { threadId: ChatThreadId; title: string },
): ChatMutationResult => {
  if (snapshot.threads.some((thread) => thread.threadId === params.threadId)) {
    return { ok: false, reason: "duplicate-thread" };
  }
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      threads: [
        ...snapshot.threads,
        { threadId: params.threadId, title: params.title, messages: [] },
      ],
    },
  };
};

export const appendMessage = (
  snapshot: ChatSnapshot,
  params: { threadId: ChatThreadId; message: ChatMessage },
): ChatMutationResult => {
  const index = snapshot.threads.findIndex((thread) => thread.threadId === params.threadId);
  if (index === -1) return { ok: false, reason: "unknown-thread" };
  const threads = snapshot.threads.map((thread, position) =>
    position === index ? { ...thread, messages: [...thread.messages, params.message] } : thread,
  );
  return { ok: true, snapshot: { ...snapshot, revision: snapshot.revision + 1, threads } };
};
