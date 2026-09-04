import type {
  ChatMessage,
  ChatSnapshot,
  ChatThreadId,
  ChatThreadKind,
  PromptProfile,
} from "./schemas/chat.js";
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
  params: { threadId: ChatThreadId; title: string; kind: ChatThreadKind },
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
        { threadId: params.threadId, title: params.title, kind: params.kind, messages: [] },
      ],
    },
  };
};

/**
 * `kind`ごとのスレッド数。kindを持たないスレッド（この項目を足す前に作られたもの）は
 * manualとして数える——ステージ用の枠を、過去のスレッドで先に埋めさせない。
 */
export const countThreadsOfKind = (snapshot: ChatSnapshot, kind: ChatThreadKind): number =>
  snapshot.threads.filter((thread) => (thread.kind ?? "manual") === kind).length;

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

/**
 * 送信内容の指紋。commandIdは冪等キーだが、本文とは結びついていない——同じIDで別の
 * 本文を送られると、DOは「同じ送信の再送」とみなして元の結果を返し、クライアントは
 * 送ったつもりの本文が消えたことに気づけない。threadId・promptProfile・本文を1つの
 * ハッシュへ畳み、再送のたびに突き合わせて取り違えを弾く。
 *
 * 区切りに改行を挟むのは、隣接するフィールドの境界を潰さないため（"ab"+"c" と
 * "a"+"bc" が同じ指紋にならないようにする）。
 */
export const chatCommandFingerprint = async (command: {
  readonly threadId: string;
  readonly promptProfile?: PromptProfile;
  readonly text: string;
}): Promise<string> => {
  const source = `${command.threadId}\n${command.promptProfile ?? "default"}\n${command.text}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
