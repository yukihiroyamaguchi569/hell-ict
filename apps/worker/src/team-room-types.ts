import type {
  AiMessage,
  ChatMessageResult,
  ChatSnapshot,
  ChatThreadId,
  ChatThreadKind,
  PromptProfile,
} from "@hell-ict/domain";

import type { ChatClaimToken } from "./guard.js";

/**
 * Reply types of TeamRoom's public RPC methods, shared with the Worker modules that call them.
 * Types only: this module must not import team-room.ts, so callers can depend on it without a cycle.
 */

/**
 * スレッド作成の結果。`created`は「このリクエストで実際にスレッドが増えたか」で、
 * 冪等再送とステージスレッドの重複抑止では false になる。Workerはこれを見て
 * 活動ログの`thread.create`を記録するかどうかを決める——スナップショットの末尾を
 * 作成されたスレッドとみなすと、増えていない経路でも記録が積まれ、しかも無関係な
 * threadIdが載る。
 */
export type CreateThreadOutcome =
  | { snapshot: ChatSnapshot; created: false }
  | { snapshot: ChatSnapshot; created: true; threadId: ChatThreadId };

export type ConflictReply = { conflict: true };
/**
 * ゲームマスターのリセットより前に入室した端末からの書き込み。進捗・チェックポイントと
 * 同じく、何も書かずに拒否する——ここを通すと、古いタブのステージ遷移やスレッド作成が
 * 初期化したはずのチーム状態と会話を作り直してしまう。冪等台帳にも触れない。
 */
export type StaleGenerationReply = { staleGeneration: true };
export type UnknownThreadReply = { unknownThread: true };

/** スレッド上限に達した作成要求。DOには何も保存しない。kindごとに文言を変える。 */
export type ThreadLimitReply = { threadLimit: true; max: number; kind: ChatThreadKind };

export type BeginChatMessageOutcome =
  | { kind: "already-processed"; result: ChatMessageResult }
  | { kind: "pending"; history: AiMessage[]; token: ChatClaimToken }
  | { kind: "in-progress" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  // 同じcommandIdが別のスレッド／別のpromptProfileで使い回された。冪等再送ではなく
  // クライアント側の取り違えなので、pendingを流用せず409で突き返す。
  | { kind: "conflict" };

export type CompleteChatMessageOutcome = { kind: "success"; text: string } | { kind: "failure" };

/**
 * ステージの経路（beginStageChatMessage）でサーバが決めた送り先。`text`は活動ログ用で、
 * 再開した下書き（本文を組み立て直さない）ではnull。
 */
export type StageChatRoute = {
  threadId: ChatThreadId;
  promptProfile: PromptProfile;
  text: string | null;
};

/**
 * beginStageChatMessageの結果。AIへ進むのは`pending`だけで、送り先を添える。
 * - refused: 今のステージにはその送信を受けるAIが無い／会話を用意できていない。
 * - draftRejected: Stage 1の下書きの条件を満たさない（judgeStage1DraftRequestの理由）。
 * - piiBlocked: 送信前ゲートで止めた。何も保存していない。Stage 5では罠も確定している。
 */
export type BeginStageChatOutcome =
  | Exclude<BeginChatMessageOutcome, { kind: "pending" }>
  | (Extract<BeginChatMessageOutcome, { kind: "pending" }> & { route: StageChatRoute })
  | UnknownThreadReply
  | StaleGenerationReply
  | { refused: "no-ai-chat" | "thread-not-ready" }
  | { draftRejected: string }
  | { piiBlocked: { promptProfile: PromptProfile | null; length: number } };

/**
 * beginChatMessageへ渡す、コマンド本体以外の入力。fingerprintの計算はWebCryptoで
 * 非同期なのでWorker側で済ませて渡す——DOの中でawaitすると、その隙に同じcommandIdの
 * 別リクエストが入り込み、冪等判定と枠消費が二重に走りうる。
 */
export type BeginChatMessageGate = {
  readonly nowMs: number;
  readonly limit: number;
  readonly fingerprint: string;
};
