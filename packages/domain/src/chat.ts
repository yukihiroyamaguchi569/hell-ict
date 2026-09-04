import { sha256Hex } from "./fingerprint.js";
import { CHAT_MESSAGE_MAX_CHARS } from "./schemas/chat.js";
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
export const chatCommandFingerprint = (command: {
  readonly threadId: string;
  readonly promptProfile?: PromptProfile;
  readonly text: string;
}): Promise<string> =>
  sha256Hex(`${command.threadId}\n${command.promptProfile ?? "default"}\n${command.text}`);

/**
 * OpenAIの応答をchatMessageSchemaのtextに載る形へ整える。載せられないならnullを返し、
 * 呼び出し側は失敗として扱う（snapshotを汚さない）。
 *
 * - 空白だけの応答はnull。schemaのmin(1)に落ちる値をsnapshotへ積むと、以後その
 *   スレッドの読み出しがparse失敗で丸ごと壊れる。
 * - 上限超過は切り詰めて保存する。失敗にするとクライアントが再送し、OpenAIをもう一度
 *   呼んで同じ長さの応答が返るだけで、課金と待ち時間が増えて詰む。会話としては
 *   末尾が欠けるだけで成立するので、切り捨てを許容する。
 */
export const normalizeAssistantText = (text: string): string | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > CHAT_MESSAGE_MAX_CHARS
    ? trimmed.slice(0, CHAT_MESSAGE_MAX_CHARS)
    : trimmed;
};
