import { sha256Hex } from "./fingerprint.js";
import { redactPii } from "./pii.js";
import { CHAT_MESSAGE_MAX_CHARS } from "./schemas/chat.js";
import type {
  ChatMessage,
  ChatMessageResult,
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

/**
 * snapshot内の全メッセージ本文へredactPiiを掛ける。伏せ字化を入れる前に保存された
 * 平文が、GET・WebSocket配信・台帳の再生から出続けるのを止めるための移行用。
 *
 * 変化が無ければ引数と同じ参照をそのまま返す。呼び出し側は参照比較だけで
 * 「保存し直しが要るか」を判断でき、毎回の読み出しで書き込みが走らない。
 */
export const redactSnapshotPii = (snapshot: ChatSnapshot): ChatSnapshot => {
  const threads = snapshot.threads.map((thread) => {
    const messages = thread.messages.map((message) => {
      const text = redactPii(message.text);
      return text === message.text ? message : { ...message, text };
    });
    // 中身が1つも変わっていなければ元のthreadを返す（参照が変わらないことが
    // 「保存し直しは要らない」の合図になる）。
    return messages.every((message, index) => message === thread.messages[index])
      ? thread
      : { ...thread, messages };
  });
  return threads.every((thread, index) => thread === snapshot.threads[index])
    ? snapshot
    : { ...snapshot, threads };
};

/**
 * 冪等台帳へ保存したチャット結果の伏せ字化。台帳の行には当時のsnapshot全体が入るので、
 * 返却値だけ伏せ字にしても行の中には平文が残り続ける（呼び出し側が行ごと保存し直す）。
 *
 * redactSnapshotPiiと同じく、変化が無ければ引数と同じ参照を返す。
 */
export const redactChatMessageResultPii = (result: ChatMessageResult): ChatMessageResult => {
  const snapshot = redactSnapshotPii(result.snapshot);
  const text = redactPii(result.assistant.text);
  return snapshot === result.snapshot && text === result.assistant.text
    ? result
    : { snapshot, assistant: { ...result.assistant, text } };
};
