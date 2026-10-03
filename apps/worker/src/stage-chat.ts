import { sha256Hex, stableStringify, stageChatCommandSchema } from "@hell-ict/domain";
import type { StageChatCommand, TeamCode } from "@hell-ict/domain";

import { chatLogger, finishChatTurn, respondToBeginRefusal } from "./chat-turn.js";
import type { ChatGate, ChatMessageDeps } from "./chat-turn.js";
import { parseChatRateLimit } from "./guard.js";
import { bodyErrorResponse, error, json, parseJson } from "./http.js";
import type { RequestScope } from "./http.js";
import type { BeginStageChatOutcome } from "./team-room-types.js";

/**
 * `POST /api/teams/:code/game/chat/messages`: 今のステージのAIへ送る（Issue #236）。
 *
 * 画面は本文（Stage 1の下書きはメールID・コンテキスト・要点）だけを送り、送り先の会話と
 * システムプロンプトはサーバがゲーム状態のステージから選ぶ。Stage 3の罠のプロンプト注入は
 * 画面の申告に依存しない。旧経路の`chat/messages`（threadIdとpromptProfileを画面が送る）は
 * 予備のモックのためにそのまま残す。
 *
 * 応答の形は旧経路と同じ（成功は`{ snapshot, assistant }`、失敗は`{ message, code }`）。
 * この経路だけの拒否は409の`no_ai_chat`・`thread_not_ready`・`draft_rejected`（理由は
 * `reason`）。送信前PIIゲートは422の`pii_blocked`で、Stage 5ではゲーム状態の罠（罰の開始）も
 * 同時に確定している——画面は`GET /game`で`penalties.s5`を読み直す。
 */

const DRAFT_MESSAGES: Readonly<Record<string, string>> = {
  "no-material": "要点か、コンテキストが必要です。",
  "no-ai": "このラウンドではAIに下書きさせられません。",
  "not-started": "Stage 1 がまだ始まっていません。",
};

type StageChatRefusal = Extract<
  BeginStageChatOutcome,
  { refused: unknown } | { draftRejected: unknown } | { piiBlocked: unknown }
>;

/** この経路だけの拒否をResponseへ畳む。PIIゲートの拒否は長さだけを活動ログへ残す。 */
const respondToStageRefusal = (
  refusal: StageChatRefusal,
  scope: RequestScope,
  teamCode: TeamCode,
  command: StageChatCommand,
): Response => {
  if ("refused" in refusal)
    return refusal.refused === "no-ai-chat"
      ? error("このステージではAIへ送信できません。", 409, "no_ai_chat")
      : error("会話の準備に失敗しました。再試行してください。", 409, "thread_not_ready");
  if ("draftRejected" in refusal)
    return json(
      {
        message:
          DRAFT_MESSAGES[refusal.draftRejected] ?? "このメールには今は下書きさせられません。",
        code: "draft_rejected",
        reason: refusal.draftRejected,
      },
      409,
    );
  const { promptProfile, length } = refusal.piiBlocked;
  chatLogger(scope, teamCode, {
    commandId: command.commandId,
    promptProfile: promptProfile ?? undefined,
  })("chat.pii_blocked", { meta: { length } });
  return error("個人情報を検知したため、送信をブロックしました。", 422, "pii_blocked");
};

const isStageRefusal = (begin: BeginStageChatOutcome): begin is StageChatRefusal =>
  "refused" in begin || "draftRejected" in begin || "piiBlocked" in begin;

const parseStageChatCommand = async (
  request: Request,
): Promise<{ ok: true; command: StageChatCommand } | { ok: false; response: Response }> => {
  try {
    return { ok: true, command: stageChatCommandSchema.parse(await parseJson(request)) };
  } catch (caught) {
    return { ok: false, response: bodyErrorResponse(caught, "commandの形式が不正です。") };
  }
};

export const handleStageChatMessage = async (
  request: Request,
  scope: RequestScope,
  teamCode: TeamCode,
  deps: ChatMessageDeps,
): Promise<Response> => {
  const parsed = await parseStageChatCommand(request);
  if (!parsed.ok) return parsed.response;
  const { command } = parsed;
  const room = scope.env.TEAM_ROOM.getByName(teamCode);
  // 指紋はここで計算してDOへ渡す（旧経路と同じ理由）。本文・下書きの材料・種類を畳む。
  const gate: ChatGate = {
    nowMs: deps.nowMs,
    limit: parseChatRateLimit(scope.env.CHAT_RATE_LIMIT_PER_MINUTE),
    fingerprint: await sha256Hex(stableStringify(command)),
  };
  const begin = await room.beginStageChatMessage(teamCode, command, gate).catch(() => null);
  if (begin === null)
    return error("メッセージの処理に失敗しました。時間を置いて再試行してください。", 503);
  if (isStageRefusal(begin)) return respondToStageRefusal(begin, scope, teamCode, command);
  if (!("kind" in begin) || begin.kind !== "pending") return respondToBeginRefusal(begin);

  const { route } = begin;
  const log = chatLogger(scope, teamCode, {
    commandId: command.commandId,
    threadId: route.threadId,
    promptProfile: route.promptProfile,
  });
  log("chat.user", { role: "user", ...(route.text === null ? {} : { text: route.text }) });
  return finishChatTurn(
    room,
    log,
    {
      commandId: command.commandId,
      promptProfile: route.promptProfile,
      history: begin.history,
      token: begin.token,
    },
    deps.aiGateway,
  );
};
