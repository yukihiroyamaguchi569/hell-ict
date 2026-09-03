import {
  createThreadCommandSchema,
  detectPii,
  sendMessageCommandSchema,
  teamCodeSchema,
  teamCommandSchema,
} from "@hell-ict/domain";
import type {
  AiGateway,
  AiMessage,
  ChatMessageResult,
  CreateThreadCommand,
  CreateThreadResult,
  SendMessageCommand,
  TeamCode,
  TeamCommand,
} from "@hell-ict/domain";

import { handleActivityPost, logActivity, redactPiiText } from "./activity-log.js";
import type { ActivityEvent } from "./activity-log.js";
import { error, isWebSocketRequest, json, parseJson, teamCodeFromPath } from "./http.js";
import type { RequestScope } from "./http.js";
import { createAiGateway, OpenAiRefusalError } from "./openai-gateway.js";
import { handleProgressPost, handleProgressSummary } from "./progress.js";
import { RaceLeaderboard } from "./race-leaderboard.js";
import { systemPromptFor } from "./stage-prompts.js";
import { TeamRoom } from "./team-room.js";

export { RaceLeaderboard, TeamRoom };

const CHAT_TIMEOUT_MS = 20_000;

const handleSession = async (request: Request, env: Env): Promise<Response> => {
  let teamCode: TeamCode;
  try {
    const input = await parseJson(request);
    teamCode = teamCodeSchema.parse(
      typeof input === "object" && input !== null && "teamCode" in input
        ? input.teamCode
        : undefined,
    );
  } catch {
    return error("teamCodeはASCII数字6桁で指定してください。", 400);
  }
  try {
    const snapshot = await env.TEAM_ROOM.getByName(teamCode).join(teamCode);
    await env.RACE_LEADERBOARD.getByName("global").upsert(teamCode, snapshot);
    return json(snapshot);
  } catch {
    return error("チーム状態の処理に失敗しました。時間を置いて再試行してください。", 503);
  }
};

const handleCommand = async (request: Request, env: Env, teamCode: TeamCode): Promise<Response> => {
  let command: TeamCommand;
  try {
    command = teamCommandSchema.parse(await parseJson(request));
  } catch {
    return error("commandの形式が不正です。", 400);
  }
  try {
    const result = await env.TEAM_ROOM.getByName(teamCode).command(teamCode, command);
    if ("conflict" in result) return error("状態の競合または許可されない遷移です。", 409);
    return json(result, result.leaderboardPending ? 503 : 200);
  } catch {
    return error("コマンドの処理に失敗しました。時間を置いて再試行してください。", 503);
  }
};

/**
 * `waitUntil`へ逃がした活動ログの完了をテストから待てるよう、handleChatMessageと
 * 同じくハンドラ自体を公開する（テスト側でExecutionContextを作って渡す）。
 */
export const handleCreateThread = async (
  request: Request,
  scope: RequestScope,
  teamCode: TeamCode,
): Promise<Response> => {
  let command: CreateThreadCommand;
  try {
    command = createThreadCommandSchema.parse(await parseJson(request));
  } catch {
    return error("commandの形式が不正です。", 400);
  }
  try {
    const result: CreateThreadResult = await scope.env.TEAM_ROOM.getByName(teamCode).createThread(
      teamCode,
      command,
    );
    // 作成されたスレッドは末尾へ足される（domainのcreateThread）。分析で
    // 「いつ文脈を分けたか」を追えるよう、そのthreadIdごと記録する。
    logActivity(scope, {
      teamCode,
      kind: "thread.create",
      threadId: result.snapshot.threads.at(-1)?.threadId,
      commandId: command.commandId,
      meta: { title: command.title },
    });
    return json(result);
  } catch {
    return error("スレッドの作成に失敗しました。時間を置いて再試行してください。", 503);
  }
};

type ChatAiOutcome = { kind: "success"; text: string } | { kind: "failure" };

/**
 * AI呼び出しの成否をDOへ渡す`outcome`へ変換しつつ、ポリシー拒否（再試行しても
 * 無意味）だけを区別できるよう`refusal`も併せて返す。handleChatMessageの
 * 複雑度を下げるための切り出し。
 */
const runAiCompletion = async (
  aiGateway: AiGateway,
  history: readonly AiMessage[],
): Promise<{ outcome: ChatAiOutcome; refusal: string | null }> => {
  let refusal: string | null = null;
  const response = await aiGateway
    .complete({ messages: history, timeoutMs: CHAT_TIMEOUT_MS })
    .catch((caught: unknown) => {
      if (caught instanceof OpenAiRefusalError) refusal = caught.message;
      return null;
    });
  return {
    outcome: response === null ? { kind: "failure" } : { kind: "success", text: response.text },
    refusal,
  };
};

/** AI応答保存の結果をHTTP応答へ変換する。handleChatMessageの複雑度を下げるための切り出し。 */
const respondToCompletion = (
  result: ChatMessageResult | { retry: true } | null,
  refusal: string | null,
): Response => {
  if (result === null)
    return error("応答の保存に失敗しました。時間を置いて再試行してください。", 503);
  if ("retry" in result) {
    return refusal !== null
      ? error(`AIが回答を拒否しました: ${refusal}`, 422)
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
): Promise<Response | null> => {
  if (!history.some((message) => detectPii(message.text) !== null)) return null;
  const blocked = await room.completeChatMessage(commandId, { kind: "failure" }).catch(() => null);
  return blocked === null
    ? error("メッセージの処理に失敗しました。時間を置いて再試行してください。", 503)
    : error("会話履歴に個人情報を検知したため、送信をブロックしました。", 422);
};

/** 1回の送信に紐づく活動ログの書き手。kindごとの差分だけを渡せば済むようにする。 */
type ChatLogger = (kind: string, extra?: Partial<ActivityEvent>) => void;

/**
 * teamCode・threadId・commandIdといった毎回同じ値を閉じ込めた書き手を作る。
 * handleChatMessageは既に複雑度の上限にいるため、`promptProfile`の既定値の解決も
 * ここへ寄せて、呼び出し側へ分岐を増やさない。
 */
const chatLogger = (
  scope: RequestScope,
  teamCode: TeamCode,
  command: SendMessageCommand,
): ChatLogger => {
  const promptProfile = command.promptProfile ?? "default";
  // この書き手を通る本文は種別を問わずPIIゲートへ掛ける。送信前ゲートを抜けた
  // ユーザー本文だけでなくAI応答も対象にし、kindを足したときに素通りする口を作らない。
  return (kind, extra) => {
    logActivity(scope, {
      teamCode,
      kind,
      threadId: command.threadId,
      commandId: command.commandId,
      ...extra,
      ...redactPiiText(extra?.text, { promptProfile, ...extra?.meta }),
    });
  };
};

/** AI応答の顛末を1行書く。handleChatMessageへ分岐を増やさないための切り出し。 */
const logChatOutcome = (
  log: ChatLogger,
  result: ChatMessageResult | { retry: true } | null,
  refusal: string | null,
): void => {
  if (result !== null && !("retry" in result)) {
    log("chat.assistant", {
      role: "assistant",
      text: result.assistant.text,
      messageId: result.assistant.messageId,
    });
    return;
  }
  if (refusal !== null) {
    log("chat.refusal", { meta: { refusal } });
    return;
  }
  log("chat.failure");
};

export const handleChatMessage = async (
  request: Request,
  scope: RequestScope,
  teamCode: TeamCode,
  aiGateway: AiGateway,
): Promise<Response> => {
  let command: SendMessageCommand;
  try {
    command = sendMessageCommandSchema.parse(await parseJson(request));
  } catch {
    return error("commandの形式が不正です。", 400);
  }

  // 送信前PIIゲート（企画書§7）。DO・AiGatewayのどちらにも触れる前に止める——
  // ユーザーメッセージを保存させず、OpenAIへも一切送らない。何も保存していないので
  // "pii_blocked"を付け、クライアントが新しいcommandIdで書き直せることを示す。
  // 本文はD1にも残さない（外部へ出さないのと同じ理由。長さだけ残して、
  // 「どのくらいの分量を書いていて弾かれたか」を分析で追えるようにする）。
  const log = chatLogger(scope, teamCode, command);
  if (detectPii(command.text) !== null) {
    log("chat.pii_blocked", { meta: { length: command.text.length } });
    return error("個人情報を検知したため、送信をブロックしました。", 422, "pii_blocked");
  }

  const room = scope.env.TEAM_ROOM.getByName(teamCode);
  const begin = await room.beginChatMessage(teamCode, command).catch(() => null);
  if (begin === null)
    return error("メッセージの処理に失敗しました。時間を置いて再試行してください。", 503);
  if ("unknownThread" in begin) return error("指定されたスレッドが見つかりません。", 404);
  if (begin.kind === "already-processed") return json(begin.result);
  if (begin.kind === "in-progress")
    return error("同じ内容が既に送信処理中です。少し待って再試行してください。", 409);

  // ここまで来た送信だけを1行として記録する（already-processedの再送は
  // 新しい発言ではないので記録しない。同じcommandIdの再試行はINSERT OR IGNOREで潰れる）。
  log("chat.user", { role: "user", text: command.text });

  const historyBlock = await blockHistoryPii(room, command.commandId, begin.history);
  if (historyBlock !== null) {
    log("chat.history_pii");
    return historyBlock;
  }

  // ステージ別システムプロンプトは送信時にだけ前置し、DOへ保存される履歴には含めない
  // （保存対象はユーザー/アシスタントのやり取りのみ。企画書§5のStage別罠設計）。
  const historyWithSystemPrompt: readonly AiMessage[] = [
    { role: "system", text: systemPromptFor(command.promptProfile) },
    ...begin.history,
  ];
  const { outcome, refusal } = await runAiCompletion(aiGateway, historyWithSystemPrompt);
  const result = await room.completeChatMessage(command.commandId, outcome).catch(() => null);
  logChatOutcome(log, result, refusal);
  return respondToCompletion(result, refusal);
};

const handleTeamSync = (request: Request, env: Env, teamCode: TeamCode): Promise<Response> => {
  if (!isWebSocketRequest(request)) return Promise.resolve(error("WebSocket接続が必要です。", 426));
  const target = new URL(request.url);
  target.searchParams.set("teamCode", teamCode);
  return env.TEAM_ROOM.getByName(teamCode).fetch(new Request(target, request));
};

const handleLeaderboardSync = (request: Request, env: Env): Promise<Response> =>
  isWebSocketRequest(request)
    ? env.RACE_LEADERBOARD.getByName("global").fetch(request)
    : Promise.resolve(error("WebSocket接続が必要です。", 426));

const handlePost = (request: Request, scope: RequestScope, url: URL): Promise<Response> => {
  const { env } = scope;
  if (url.pathname === "/api/session") return handleSession(request, env);
  if (url.pathname === "/api/progress") return handleProgressPost(request, env);
  const activityTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/activity");
  if (activityTeamCode !== null) return handleActivityPost(request, env, activityTeamCode);
  const threadsTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/chat/threads");
  if (threadsTeamCode !== null) return handleCreateThread(request, scope, threadsTeamCode);
  const messagesTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/chat/messages");
  if (messagesTeamCode !== null)
    return handleChatMessage(request, scope, messagesTeamCode, createAiGateway(env));
  const commandTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/commands");
  return commandTeamCode === null
    ? Promise.resolve(new Response("Not found", { status: 404 }))
    : handleCommand(request, env, commandTeamCode);
};

const handleChatSnapshot = async (env: Env, teamCode: TeamCode): Promise<Response> => {
  try {
    const snapshot = await env.TEAM_ROOM.getByName(teamCode).chatSnapshot(teamCode);
    return json(snapshot);
  } catch {
    return error("チャット状態の取得に失敗しました。時間を置いて再試行してください。", 503);
  }
};

const handleGet = (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.pathname === "/api/progress/summary") return handleProgressSummary(env);
  const teamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/sync");
  if (teamCode !== null) return handleTeamSync(request, env, teamCode);
  const chatTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/chat");
  if (chatTeamCode !== null) return handleChatSnapshot(env, chatTeamCode);
  return url.pathname === "/api/leaderboard/sync"
    ? handleLeaderboardSync(request, env)
    : Promise.resolve(new Response("Not found", { status: 404 }));
};

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ status: "ok" });
    }
    if (request.method === "POST") return handlePost(request, { env, ctx }, url);
    if (request.method === "GET") return handleGet(request, env, url);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export default worker;
