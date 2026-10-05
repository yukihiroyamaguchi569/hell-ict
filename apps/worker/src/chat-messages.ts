import {
  appendMessage,
  chatMessageResultSchema,
  chatMessageSchema,
  chatSnapshotSchema,
  normalizeAssistantText,
  redactPii,
} from "@hell-ict/domain";
import type {
  ChatMessage,
  ChatMessageResult,
  ChatSnapshot,
  SendMessageCommand,
  TeamCode,
} from "@hell-ict/domain";

import {
  expirePendingMessages,
  isClaimStale,
  mismatchesPending,
  promptProfileOf,
  readPending,
  readProcessedMessage,
  replayProcessed,
} from "./chat-ledger.js";
import type { StoredPendingMessage } from "./chat-ledger.js";
import type { ChatStore, StoredChatState } from "./chat-store.js";
import type { ChatClaimToken } from "./guard.js";
import { consumeRateLimit } from "./rate-limit-store.js";
import type {
  BeginChatMessageGate,
  BeginChatMessageOutcome,
  CompleteChatMessageOutcome,
  UnknownThreadReply,
} from "./team-room-types.js";

/**
 * TeamRoom's chat message intake (pending row, rate limit, resuming a claim) and completion
 * (assistant reply, processed row). Input parsing and the reset-generation check stay in
 * TeamRoom (the RPC surface). Everything here is synchronous so TeamRoom can call it in the
 * same synchronous section as its other writes, and inside transactionSync.
 */

/**
 * 応答をsnapshotへ載せられる形へ整える。失敗と、載せられない応答（空白だけ）は
 * どちらもnullへ畳む——空の本文をsnapshotへ積むと、以後そのスレッドの読み出しが
 * parse失敗で丸ごと壊れる。上限超過はnormalizeAssistantTextが切り詰める。
 */
const assistantTextOf = (outcome: CompleteChatMessageOutcome): string | null => {
  if (outcome.kind !== "success") return null;
  const normalized = normalizeAssistantText(outcome.text);
  if (normalized === null) return null;
  // AI応答にPIIが混ざることがある（Stage 4の設計上、モデルは渡された文脈を復唱しうる）。
  // 平文でchat_stateとprocessed台帳へ残すと、以後のGETでも配信され続けるので、保存前に
  // 伏せ字へ置き換える。拒否ではなく置換を選ぶ理由はdomainのredactPiiに書いた。
  // 伏せ字化で長さが変わりうるので、もう一度上限へ収める。
  return normalizeAssistantText(redactPii(normalized));
};

/**
 * What ChatMessages needs from the DO. `readGeneration` is a callback, not a value, so the
 * reset generation is read from SQL at the same points as before the move.
 */
export type ChatMessagesContext = {
  readonly storage: DurableObjectStorage;
  readonly chatStore: ChatStore;
  readonly readGeneration: () => number;
  readonly broadcastChat: (snapshot: ChatSnapshot) => void;
};

export class ChatMessages {
  constructor(private readonly context: ChatMessagesContext) {}

  /** Accepts a send whose generation the caller has already checked (see beginChatMessage). */
  begin(
    teamCode: TeamCode,
    command: SendMessageCommand,
    validated: BeginChatMessageGate,
  ): BeginChatMessageOutcome | UnknownThreadReply {
    const { fingerprint } = validated;
    expirePendingMessages(this.context.storage.sql);
    const processed = readProcessedMessage(this.context.storage.sql, command.commandId);
    if (processed !== null) return replayProcessed(processed, fingerprint);

    const pending = readPending(this.context.storage.sql, command.commandId);
    if (pending !== null) {
      // 同じcommandIdを別の内容（別スレッド／別profile／別本文）で使い回した送信は、
      // 冪等再送ではなくクライアント側の取り違えである。pendingの履歴を流用すると、
      // 別スレッドの文脈をそのままAIへ渡してしまうので、流用せずに突き返す。
      if (mismatchesPending(pending, command, fingerprint)) return { kind: "conflict" };
      return this.resumePending(teamCode, command.commandId, pending, validated);
    }
    return this.appendPendingMessage(teamCode, command, validated);
  }

  /**
   * 新しい送信のユーザー発言を保存し、pending行を作る。枠の消費もここで行う
   * （beginChatMessageの注記）。ステージの経路（beginStageChatMessage）も、送り先と
   * プロンプトをサーバで決めた後にここを通る。
   */
  appendPendingMessage(
    teamCode: TeamCode,
    command: SendMessageCommand,
    gate: BeginChatMessageGate,
  ): BeginChatMessageOutcome | UnknownThreadReply {
    const { nowMs, limit, fingerprint } = gate;
    const snapshot = this.context.chatStore.loadChatSnapshot(teamCode);
    if (!snapshot.threads.some((thread) => thread.threadId === command.threadId)) {
      return { unknownThread: true };
    }
    const userMessage: ChatMessage = {
      messageId: crypto.randomUUID(),
      role: "user",
      text: command.text,
      createdAt: new Date().toISOString(),
    };
    const appended = appendMessage(snapshot, { threadId: command.threadId, message: userMessage });
    if (!appended.ok) return { unknownThread: true };
    // ここまでは何も永続化していない。「枠の加算・snapshotの保存・pending行の作成」は
    // 全部そろって初めて意味を持つので、1つのトランザクションにまとめる。途中で
    // ストレージが失敗しても、枠だけ減ってメッセージが残らない中途半端な状態にしない。
    // 超過のときはconsumeRateLimitが1行も書かずに戻るため、この中では何も起きない。
    const retryAfterSeconds = this.context.storage.transactionSync(() => {
      const retry = consumeRateLimit(this.context.storage.sql, "chat", nowMs, limit);
      if (retry !== null) return retry;
      this.context.chatStore.saveChatSnapshot(appended.snapshot);
      const now = new Date().toISOString();
      this.context.storage.sql.exec(
        "INSERT INTO pending_message_commands (command_id, thread_id, created_at, claimed_at, prompt_profile, fingerprint, claim_generation) VALUES (?, ?, ?, ?, ?, ?, 1)",
        command.commandId,
        command.threadId,
        now,
        now,
        promptProfileOf(command),
        fingerprint,
      );
      return null;
    });
    if (retryAfterSeconds !== null) return { kind: "rate-limited", retryAfterSeconds };
    this.context.broadcastChat(appended.snapshot);
    return {
      kind: "pending",
      history: this.context.chatStore.historyFor(appended.snapshot, command.threadId),
      token: { claimGeneration: 1, resetGeneration: this.context.readGeneration() },
    };
  }

  /**
   * 既にpending行が残っているcommandIdの再送を捌く。クレームが生きていれば処理中、
   * 古ければ取り直して履歴を返す。どちらも新しい送信ではないので枠は消費しない。
   * beginChatMessageの複雑度を下げるための切り出し。
   * 内容の照合（取り違えならconflict）は呼び出し側で済ませてから呼ぶ。
   */
  resumePending(
    teamCode: TeamCode,
    commandId: string,
    pending: StoredPendingMessage,
    gate: BeginChatMessageGate,
  ): BeginChatMessageOutcome {
    if (!isClaimStale(pending.claimed_at)) return { kind: "in-progress" };
    // ここから先はこれから改めてOpenAIを呼ぶ経路なので、新規送信と同じく枠を1つ消費する。
    // completeChatMessageはAI失敗・refusalでクレームを解放するため、消費しないと
    // 「失敗する本文を同じcommandIdで投げ続ける」だけでレート制限に一切当たらず
    // OpenAIを何度でも呼べてしまう。AIを呼ばない再送——processed（結果を返すだけ）と
    // クレームが生きている最中（in-progress）——は従来どおり消費しない。
    const retryAfterSeconds = consumeRateLimit(
      this.context.storage.sql,
      "chat",
      gate.nowMs,
      gate.limit,
    );
    // 超過してもpending行は消さない。ユーザー発言は既に保存済みで、行を消すと
    // 同じcommandIdの再送が新規送信として二重に積まれる（冪等性を失う）。
    if (retryAfterSeconds !== null) return { kind: "rate-limited", retryAfterSeconds };
    // 未クレーム、またはクレームが古い（AI呼び出しが完了しないまま終わった）ので、
    // ここで改めてクレームを取り直してから再試行させる。世代番号を1つ進めることで、
    // 前のクレームで走っていたAI呼び出しが後から戻ってきても弾ける（fencing token）。
    const claimGeneration = (pending.claim_generation ?? 0) + 1;
    this.context.storage.sql.exec(
      "UPDATE pending_message_commands SET claimed_at = ?, claim_generation = ? WHERE command_id = ?",
      new Date().toISOString(),
      claimGeneration,
      commandId,
    );
    const snapshot = this.context.chatStore.loadChatSnapshot(teamCode);
    return {
      kind: "pending",
      history: this.context.chatStore.historyFor(snapshot, pending.thread_id),
      token: { claimGeneration, resetGeneration: this.context.readGeneration() },
    };
  }

  /**
   * Settles an AI call whose reset generation the caller has already checked
   * (see completeChatMessage).
   */
  complete(
    commandId: string,
    outcome: CompleteChatMessageOutcome,
    token: ChatClaimToken,
  ): ChatMessageResult | { retry: true } | { stale: true } {
    // 伏せ字化と行の保存し直しを含む読み出しをここでも通す（beginと同じ）。
    const processed = readProcessedMessage(this.context.storage.sql, commandId);
    if (processed !== null) return processed.result;

    const pending = readPending(this.context.storage.sql, commandId);
    if (pending === null) throw new Error("該当する送信途中のメッセージがありません。");
    if ((pending.claim_generation ?? 0) !== token.claimGeneration) return { stale: true };

    const text = assistantTextOf(outcome);
    if (text === null) {
      // クレームを解放する。解放しないと、正当な再送（同じcommandIdでの再送信）が
      // 誤って「進行中」と判定され、二度とAIを呼べなくなる。
      this.context.storage.sql.exec(
        "UPDATE pending_message_commands SET claimed_at = NULL WHERE command_id = ?",
        commandId,
      );
      return { retry: true };
    }
    return this.appendAssistantMessage(commandId, pending, text);
  }

  /**
   * 検証済みの応答をsnapshotへ積み、冪等台帳へ移す。completeChatMessageの複雑度を
   * 下げるための切り出し。
   */
  private appendAssistantMessage(
    commandId: string,
    pending: StoredPendingMessage,
    text: string,
  ): ChatMessageResult {
    const stored = this.context.storage.sql
      .exec<StoredChatState>("SELECT snapshot FROM chat_state WHERE id = 1")
      .toArray()[0];
    if (stored === undefined) throw new Error("チャット状態が見つかりません。");
    const snapshot = chatSnapshotSchema.parse(JSON.parse(stored.snapshot) as unknown);
    // schemaを通してからappendする。ここで弾かれる値がsnapshotへ入ることはない。
    const assistantMessage: ChatMessage = chatMessageSchema.parse({
      messageId: crypto.randomUUID(),
      role: "assistant",
      text,
      createdAt: new Date().toISOString(),
    });
    const appended = appendMessage(snapshot, {
      threadId: pending.thread_id,
      message: assistantMessage,
    });
    if (!appended.ok) throw new Error("応答の保存先スレッドが見つかりません。");
    const result = chatMessageResultSchema.parse({
      snapshot: appended.snapshot,
      assistant: assistantMessage,
    });
    this.context.storage.transactionSync(() => {
      this.context.chatStore.saveChatSnapshot(appended.snapshot);
      this.context.storage.sql.exec(
        // pending行の指紋をそのまま引き継ぐ。processed側にも残しておかないと、
        // 完了後の再送で内容の取り違えを検出できない。
        "INSERT INTO processed_message_commands (command_id, result, fingerprint) VALUES (?, ?, ?)",
        commandId,
        JSON.stringify(result),
        pending.fingerprint,
      );
      this.context.storage.sql.exec(
        "DELETE FROM pending_message_commands WHERE command_id = ?",
        commandId,
      );
    });
    this.context.broadcastChat(appended.snapshot);
    return result;
  }
}
