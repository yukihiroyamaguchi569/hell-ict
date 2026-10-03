import { detectPii } from "@hell-ict/domain";
import type {
  AiGateway,
  AiMessage,
  ChatMessageResult,
  PromptProfile,
  TeamCode,
} from "@hell-ict/domain";

import { logActivity } from "./activity-log.js";
import type { ActivityEvent } from "./activity-log.js";
import { aiRouteMeta } from "./ai-failover.js";
import type { AiRouteMeta } from "./ai-failover.js";
import type { ChatClaimToken } from "./guard.js";
import { error, errorWithHeaders, json, staleGenerationResponse } from "./http.js";
import type { RequestScope } from "./http.js";
import { aiFailureMeta, OpenAiRefusalError } from "./openai-gateway.js";
import type { AiFailureMeta } from "./openai-gateway.js";
import { systemPromptFor } from "./stage-prompts.js";
import type { TeamRoom } from "./team-room.js";
import type { BeginChatMessageOutcome } from "./team-room-types.js";

/**
 * AIとの1往復のうち、送信経路によらず同じ部分（Issue #236で、旧経路の`chat/messages`と
 * ステージに結び付いた`game/chat/messages`の2本になった）。どちらも「DOで送信を受け付けて
 * 履歴を得る → 履歴のPIIを確かめる → システムプロンプトを前置してAIを呼ぶ → 応答を保存する
 * → 活動ログ」の順に通る。違うのは、送り先とプロンプトを画面が選ぶか、サーバが選ぶかだけ。
 */

const CHAT_TIMEOUT_MS = 20_000;

type ChatAiOutcome = { kind: "success"; text: string } | { kind: "failure" };

/** AI呼び出しの顛末。拒否と、それ以外の失敗の原因・呼んだ経路（活動ログ用）を併せて持つ。 */
type AiCompletion = {
  outcome: ChatAiOutcome;
  refusal: string | null;
  failure: AiFailureMeta | null;
  route: Partial<AiRouteMeta>;
};

/**
 * AI呼び出しの成否をDOへ渡す`outcome`へ変換しつつ、ポリシー拒否（再試行しても
 * 無意味）だけを区別できるよう`refusal`も併せて返す。拒否以外の失敗は、原因を
 * 活動ログへ残せるよう`failure`へ畳む（参加者への応答には使わない）。
 * handleChatMessageの複雑度を下げるための切り出し。
 */
const runAiCompletion = async (
  aiGateway: AiGateway,
  history: readonly AiMessage[],
): Promise<AiCompletion> => {
  let refusal: string | null = null;
  let failure: AiFailureMeta | null = null;
  const response = await aiGateway
    .complete({ messages: history, timeoutMs: CHAT_TIMEOUT_MS })
    .catch((caught: unknown) => {
      if (caught instanceof OpenAiRefusalError) refusal = caught.message;
      else failure = aiFailureMeta(caught);
      return null;
    });
  return {
    outcome: response === null ? { kind: "failure" } : { kind: "success", text: response.text },
    refusal,
    failure,
    route: aiRouteMeta(aiGateway),
  };
};

/** AI応答保存の結果をHTTP応答へ変換する。handleChatMessageの複雑度を下げるための切り出し。 */
type CompleteChatOutcome = ChatMessageResult | { retry: true } | { stale: true } | null;

const respondToCompletion = (result: CompleteChatOutcome, refusal: string | null): Response => {
  if (result === null)
    return error("応答の保存に失敗しました。時間を置いて再試行してください。", 503);
  // クレームを別のリクエストが取り直した後に戻ってきた応答。何も書いていないので、
  // 進行中の側に任せて再試行を促す。
  if ("stale" in result)
    return error("同じ内容が既に送信処理中です。少し待って再試行してください。", 409);
  if ("retry" in result) {
    return refusal !== null
      ? error(`AIが回答を拒否しました: ${refusal}`, 422, "ai_refusal")
      : error("AI応答の取得に失敗しました。再試行してください。", 503);
  }
  return json(result);
};

/**
 * 履歴（過去に保存された分）にPIIが混ざっていないか外部送信の直前で確認する。
 * 送信前ゲートは今回の本文しか検査しないため、想定外の経路で混入した場合や、
 * 将来AIの応答自体がPIIを含んで保存された場合の防御として置く。見つかったら
 * pending行のクレームを解放し、ブロック応答を返す（このcommandIdの本文は既に
 * 保存済みなので"pii_blocked"は付けず、クライアントは同じcommandIdで再試行する）。
 * handleChatMessageの複雑度を下げるための切り出し。
 */
const blockHistoryPii = async (
  room: DurableObjectStub<TeamRoom>,
  commandId: string,
  history: readonly AiMessage[],
  token: ChatClaimToken,
): Promise<Response | null> => {
  if (!history.some((message) => detectPii(message.text) !== null)) return null;
  const blocked = await room
    .completeChatMessage(commandId, { kind: "failure" }, token)
    .catch(() => null);
  return blocked === null
    ? error("メッセージの処理に失敗しました。時間を置いて再試行してください。", 503)
    : error("会話履歴に個人情報を検知したため、送信をブロックしました。", 422, "history_pii");
};

/** 1回の送信に紐づく活動ログの書き手。kindごとの差分だけを渡せば済むようにする。 */
export type ChatLogger = (kind: string, extra?: Partial<ActivityEvent>) => void;

/**
 * teamCode・threadId・commandIdといった毎回同じ値を閉じ込めた書き手を作る。
 * handleChatMessageは既に複雑度の上限にいるため、`promptProfile`の既定値の解決も
 * ここへ寄せて、呼び出し側へ分岐を増やさない。送り先がまだ決まっていない拒否
 * （ステージの経路の送信前ゲート）では`threadId`を持たない。
 */
export const chatLogger = (
  scope: RequestScope,
  teamCode: TeamCode,
  command: {
    readonly commandId: string;
    readonly threadId?: string;
    readonly promptProfile?: PromptProfile;
  },
): ChatLogger => {
  const promptProfile = command.promptProfile ?? "default";
  // PIIの除去はactivity-log.tsの保存直前で全書き込みに掛かる。ここでは掛けない。
  return (kind, extra) => {
    logActivity(scope, {
      teamCode,
      kind,
      threadId: command.threadId,
      commandId: command.commandId,
      ...extra,
      meta: { promptProfile, ...extra?.meta },
    });
  };
};

/** AI応答の顛末を1行書く。handleChatMessageへ分岐を増やさないための切り出し。 */
const logChatOutcome = (
  log: ChatLogger,
  result: CompleteChatOutcome,
  { refusal, failure, route }: Pick<AiCompletion, "refusal" | "failure" | "route">,
): void => {
  if (result !== null && !("retry" in result) && !("stale" in result)) {
    log("chat.assistant", {
      role: "assistant",
      text: result.assistant.text,
      messageId: result.assistant.messageId,
      meta: route,
    });
    return;
  }
  if (refusal !== null) {
    log("chat.refusal", { meta: { refusal, ...route } });
    return;
  }
  // AI呼び出しが成功して保存だけが失敗した場合は、failureがnullなので原因を足さない。
  log("chat.failure", { meta: { ...failure, ...route } });
};

/**
 * 送信ハンドラの交換可能な境界。AI接続に加えて基準時刻も外から渡すことで、
 * レート制限の固定窓をテストから固定できる（max-paramsを超えないよう1つへまとめる）。
 */
export type ChatMessageDeps = {
  readonly aiGateway: AiGateway;
  readonly nowMs: number;
};

/** beginChatMessageへ渡す、レート制限の固定窓の基準値と送信内容の指紋。 */
export type ChatGate = {
  readonly nowMs: number;
  readonly limit: number;
  readonly fingerprint: string;
};

/**
 * AI呼び出しへ進まない受付の結果（スレッド不明・レート制限超過・処理済み・処理中・
 * 取り違え・世代切れ）をResponseへ畳む。
 */
export const respondToBeginRefusal = (
  begin:
    | Exclude<BeginChatMessageOutcome, { kind: "pending" }>
    | { unknownThread: true }
    | { staleGeneration: true },
): Response => {
  if ("staleGeneration" in begin) return staleGenerationResponse();
  if ("unknownThread" in begin) return error("指定されたスレッドが見つかりません。", 404);
  if (begin.kind === "rate-limited")
    return errorWithHeaders("送信が多すぎます。少し待ってから再試行してください。", 429, {
      "Retry-After": String(begin.retryAfterSeconds),
    });
  if (begin.kind === "already-processed") return json(begin.result);
  if (begin.kind === "in-progress")
    return error("同じ内容が既に送信処理中です。少し待って再試行してください。", 409);
  return error("同じ送信IDが別の内容で使われています。", 409, "conflict");
};

/** 受付を通った1往復。`history`はDOが返した、このスレッドの保存済みの会話。 */
export type ChatTurn = {
  readonly commandId: string;
  readonly promptProfile: PromptProfile | undefined;
  readonly history: readonly AiMessage[];
  readonly token: ChatClaimToken;
};

/**
 * 受付を通った送信を、AIの応答まで進める。システムプロンプトは送信時にだけ前置し、
 * DOへ保存される履歴には含めない（保存対象はユーザー/アシスタントのやり取りのみ。
 * 企画書§5のStage別罠設計）。
 */
export const finishChatTurn = async (
  room: DurableObjectStub<TeamRoom>,
  log: ChatLogger,
  turn: ChatTurn,
  aiGateway: AiGateway,
): Promise<Response> => {
  const historyBlock = await blockHistoryPii(room, turn.commandId, turn.history, turn.token);
  if (historyBlock !== null) {
    log("chat.history_pii");
    return historyBlock;
  }
  const historyWithSystemPrompt: readonly AiMessage[] = [
    { role: "system", text: systemPromptFor(turn.promptProfile) },
    ...turn.history,
  ];
  const completion = await runAiCompletion(aiGateway, historyWithSystemPrompt);
  const result = await room
    .completeChatMessage(turn.commandId, completion.outcome, turn.token)
    .catch(() => null);
  logChatOutcome(log, result, completion);
  return respondToCompletion(result, completion.refusal);
};
