import { detectPii, resolveStageChatTarget, stageAiPlan, stageChatText } from "@hell-ict/domain";
import type { StageChatCommand, TeamCode, TeamGameState } from "@hell-ict/domain";

import {
  expirePendingMessages,
  readPending,
  readProcessedMessage,
  replayProcessed,
} from "./chat-ledger.js";
import type { StoredPendingMessage } from "./chat-ledger.js";
import type { ChatMessages } from "./chat-messages.js";
import type { ChatStore } from "./chat-store.js";
import { GameStore } from "./game-store.js";
import { consumeRateLimit } from "./rate-limit-store.js";
import type {
  BeginChatMessageGate,
  BeginStageChatOutcome,
  StageChatRoute,
} from "./team-room-types.js";

/**
 * TeamRoom's stage chat intake: the server picks the thread and the system prompt from the
 * game stage, and the pre-send PII gate stops a send before anything is saved. Input parsing
 * and the reset-generation check stay in TeamRoom (the RPC surface). Everything here is
 * synchronous so TeamRoom can call it in the same synchronous section as its other writes.
 */

/**
 * What StageChatIntake needs from the DO. `readGeneration` is a callback, not a value, so the
 * reset generation is read from SQL at the same points as before the move.
 */
export type StageChatIntakeContext = {
  readonly storage: DurableObjectStorage;
  readonly chatStore: ChatStore;
  readonly chatMessages: ChatMessages;
  readonly readGeneration: () => number;
};

export class StageChatIntake {
  constructor(private readonly context: StageChatIntakeContext) {}

  /** Accepts a stage send whose generation the caller has already checked (see beginStageChatMessage). */
  begin(
    teamCode: TeamCode,
    command: StageChatCommand,
    gate: BeginChatMessageGate,
  ): BeginStageChatOutcome {
    expirePendingMessages(this.context.storage.sql);
    const processed = readProcessedMessage(this.context.storage.sql, command.commandId);
    if (processed !== null) return replayProcessed(processed, gate.fingerprint);
    const pending = readPending(this.context.storage.sql, command.commandId);
    if (pending !== null) return this.resumeStageChat(teamCode, command, pending, gate);
    return this.beginNewStageChat(teamCode, command, gate);
  }

  /**
   * ステージの経路の再送。pending行はこの経路では必ず指紋を持つので、指紋が一致しない
   * （指紋の無い古い行を含む）ものは取り違えとして突き返す。
   */
  private resumeStageChat(
    teamCode: TeamCode,
    command: StageChatCommand,
    pending: StoredPendingMessage,
    gate: BeginChatMessageGate,
  ): BeginStageChatOutcome {
    if (pending.fingerprint !== gate.fingerprint) return { kind: "conflict" };
    const outcome = this.context.chatMessages.resumePending(
      teamCode,
      command.commandId,
      pending,
      gate,
    );
    if (outcome.kind !== "pending") return outcome;
    const route: StageChatRoute = {
      threadId: pending.thread_id,
      promptProfile: pending.prompt_profile ?? "default",
      text: command.type === "stage-message" ? command.text : null,
    };
    return { ...outcome, route };
  }

  private beginNewStageChat(
    teamCode: TeamCode,
    command: StageChatCommand,
    gate: BeginChatMessageGate,
  ): BeginStageChatOutcome {
    const state = new GameStore(this.context.storage, this.context.readGeneration()).load(
      gate.nowMs,
    );
    const stage = state.game.stage;
    if (stageAiPlan(stage)?.live?.command !== command.type) return { refused: "no-ai-chat" };
    const text = stageChatText(state, command, gate.nowMs);
    if (!text.ok) return { draftRejected: text.reason };
    // 送信前PIIゲート（企画書§7）。ユーザー発言を保存させず、OpenAIへも一切送らない。
    // 会話のsnapshotはこの後で読む——読めない（壊れている）ときでも罠は確定させる。
    if (detectPii(text.text) !== null)
      return this.blockStageChatPii(state, command, gate, text.text);
    const target = resolveStageChatTarget(
      stage,
      this.context.chatStore.loadChatSnapshot(teamCode),
      command.type,
    );
    if (!target.ok) return { refused: target.reason };
    return this.appendStageChatMessage(teamCode, command, gate, {
      threadId: target.threadId,
      promptProfile: target.promptProfile,
      text: text.text,
    });
  }

  /** サーバが決めた送り先へ、旧経路と同じ受付（枠・ユーザー発言・pending行）で積む。 */
  private appendStageChatMessage(
    teamCode: TeamCode,
    command: StageChatCommand,
    gate: BeginChatMessageGate,
    route: StageChatRoute & { text: string },
  ): BeginStageChatOutcome {
    const outcome = this.context.chatMessages.appendPendingMessage(
      teamCode,
      {
        type: "send-message",
        commandId: command.commandId,
        threadId: route.threadId,
        text: route.text,
        promptProfile: route.promptProfile,
        generation: command.generation,
      },
      gate,
    );
    if (!("kind" in outcome) || outcome.kind !== "pending") return outcome;
    return { ...outcome, route };
  }

  /**
   * 送信前PIIゲートで止めた送信。旧経路と同じく枠を1つ消費する（連投で活動ログを増やせない
   * ように）。Stage 5では、同じ操作で罠（罰の開始）をゲーム状態へ確定させる——画面の申告を
   * 待たないので、OpenAIへ何も送らないことと罰の開始が同じサーバの判断で揃う。罠はSV1の
   * `s5.check-ai-message`と同じ判定・同じ台帳を通るので、同じcommandIdの再送で二度踏まない。
   * 罠は枠の判定より先に確定させる——枠を使い切った後に個人情報を送ろうとしても、罰は始まる。
   */
  private blockStageChatPii(
    state: TeamGameState,
    command: StageChatCommand,
    gate: BeginChatMessageGate,
    text: string,
  ): BeginStageChatOutcome {
    if (state.game.stage === "s5") {
      const store = new GameStore(this.context.storage, this.context.readGeneration());
      const trap = store.apply(
        {
          type: "s5.check-ai-message",
          commandId: command.commandId,
          generation: command.generation,
          text,
        },
        gate.nowMs,
        gate.fingerprint,
      );
      if ("conflict" in trap) return { kind: "conflict" };
    }
    const retryAfterSeconds = consumeRateLimit(
      this.context.storage.sql,
      "chat",
      gate.nowMs,
      gate.limit,
    );
    if (retryAfterSeconds !== null) return { kind: "rate-limited", retryAfterSeconds };
    const promptProfile = stageAiPlan(state.game.stage)?.live?.profile ?? null;
    return { piiBlocked: { promptProfile, length: text.length } };
  }
}
