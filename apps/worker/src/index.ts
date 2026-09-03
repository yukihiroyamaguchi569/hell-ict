import {
  CHECKPOINT_DATA_TOO_LARGE_MESSAGE,
  checkpointStateSchema,
  containsPii,
  createThreadCommandSchema,
  detectPii,
  saveCheckpointCommandSchema,
  saveCheckpointResultSchema,
  sendMessageCommandSchema,
  teamCodeSchema,
  teamCommandSchema,
} from "@hell-ict/domain";
import type {
  AiGateway,
  AiMessage,
  ChatMessageResult,
  CheckpointRejectionReason,
  CreateThreadCommand,
  SaveCheckpointCommand,
  SendMessageCommand,
  TeamCode,
  TeamCommand,
} from "@hell-ict/domain";

import { handleActivityPost, logActivity } from "./activity-log.js";
import type { ActivityEvent } from "./activity-log.js";
import {
  corsHeadersFor,
  isApiRequestAllowed,
  isTeamCodeAllowed,
  parseAllowedOrigins,
  parseChatRateLimit,
  parseTeamCodes,
} from "./guard.js";
import type { CorsHeaders } from "./guard.js";
import {
  bodyErrorResponse,
  error,
  errorWithHeaders,
  isWebSocketRequest,
  json,
  parseJson,
  PayloadTooLargeError,
  teamCodeFromApiPath,
  teamCodeFromPath,
} from "./http.js";
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
  } catch (caught) {
    return bodyErrorResponse(caught, "teamCodeはASCII数字6桁で指定してください。");
  }
  // 入室コードは本文にあるため入口ガードでは見られない。DOへ触れる直前でここだけ当てる
  // （未登録コードのチーム状態を作らせない）。応答は存在を明かさない404に揃える。
  if (!isTeamCodeAllowed(teamCode, parseTeamCodes(env.TEAM_CODES))) {
    return new Response("Not found", { status: 404 });
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
  } catch (caught) {
    return bodyErrorResponse(caught, "commandの形式が不正です。");
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
  } catch (caught) {
    return bodyErrorResponse(caught, "commandの形式が不正です。");
  }
  try {
    const result = await scope.env.TEAM_ROOM.getByName(teamCode).createThread(teamCode, command);
    // 上限超過は何も作られていないので、活動ログにも作成として残さない。
    if ("threadLimit" in result)
      return error(
        `スレッドは1チーム${String(result.max)}件までです。不要なスレッドの利用をやめてから作成してください。`,
        409,
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
): Promise<Response | null> => {
  if (!history.some((message) => detectPii(message.text) !== null)) return null;
  const blocked = await room.completeChatMessage(commandId, { kind: "failure" }).catch(() => null);
  return blocked === null
    ? error("メッセージの処理に失敗しました。時間を置いて再試行してください。", 503)
    : error("会話履歴に個人情報を検知したため、送信をブロックしました。", 422, "history_pii");
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

/** beginChatMessageへ渡す、レート制限の固定窓の基準値。 */
type ChatGate = { readonly nowMs: number; readonly limit: number };

/**
 * beginChatMessageを呼び、そのまま応答して終わる結果（DO失敗・スレッド不明・
 * レート制限超過・処理済み・処理中）をResponseへ畳む。AI呼び出しへ進む場合だけ
 * 履歴を返す。handleChatMessageの複雑度を下げるための切り出し。
 */
const beginOrRespond = async (
  room: DurableObjectStub<TeamRoom>,
  teamCode: TeamCode,
  command: SendMessageCommand,
  gate: ChatGate,
): Promise<{ readonly history: readonly AiMessage[] } | Response> => {
  const begin = await room
    .beginChatMessage(teamCode, command, gate.nowMs, gate.limit)
    .catch(() => null);
  if (begin === null)
    return error("メッセージの処理に失敗しました。時間を置いて再試行してください。", 503);
  if ("unknownThread" in begin) return error("指定されたスレッドが見つかりません。", 404);
  if (begin.kind === "rate-limited")
    return errorWithHeaders("送信が多すぎます。少し待ってから再試行してください。", 429, {
      "Retry-After": String(begin.retryAfterSeconds),
    });
  if (begin.kind === "already-processed") return json(begin.result);
  if (begin.kind === "in-progress")
    return error("同じ内容が既に送信処理中です。少し待って再試行してください。", 409);
  return { history: begin.history };
};

/**
 * `handleChatMessage`の交換可能な境界。AI接続に加えて基準時刻も外から渡すことで、
 * レート制限の固定窓をテストから固定できる（max-paramsを超えないよう1つへまとめる）。
 */
export type ChatMessageDeps = {
  readonly aiGateway: AiGateway;
  readonly nowMs: number;
};

export const handleChatMessage = async (
  request: Request,
  scope: RequestScope,
  teamCode: TeamCode,
  deps: ChatMessageDeps,
): Promise<Response> => {
  const { aiGateway, nowMs } = deps;
  let command: SendMessageCommand;
  try {
    command = sendMessageCommandSchema.parse(await parseJson(request));
  } catch (caught) {
    return bodyErrorResponse(caught, "commandの形式が不正です。");
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
  const begun = await beginOrRespond(room, teamCode, command, {
    nowMs,
    limit: parseChatRateLimit(scope.env.CHAT_RATE_LIMIT_PER_MINUTE),
  });
  if (begun instanceof Response) return begun;

  // ここまで来た送信だけを1行として記録する（already-processedの再送とレート制限超過は
  // 新しい発言ではないので、beginOrRespondがResponseを返した時点で記録せずに戻る。
  // 同じcommandIdの再試行はINSERT OR IGNOREで潰れる）。
  log("chat.user", { role: "user", text: command.text });

  const historyBlock = await blockHistoryPii(room, command.commandId, begun.history);
  if (historyBlock !== null) {
    log("chat.history_pii");
    return historyBlock;
  }

  // ステージ別システムプロンプトは送信時にだけ前置し、DOへ保存される履歴には含めない
  // （保存対象はユーザー/アシスタントのやり取りのみ。企画書§5のStage別罠設計）。
  const historyWithSystemPrompt: readonly AiMessage[] = [
    { role: "system", text: systemPromptFor(command.promptProfile) },
    ...begun.history,
  ];
  const { outcome, refusal } = await runAiCompletion(aiGateway, historyWithSystemPrompt);
  const result = await room.completeChatMessage(command.commandId, outcome).catch(() => null);
  logChatOutcome(log, result, refusal);
  return respondToCompletion(result, refusal);
};

/** 保存を拒否した理由ごとの409メッセージ。理由が増えたら網羅漏れを型で検出する。 */
const CHECKPOINT_REJECTION_MESSAGES = {
  conflict: "チェックポイントが競合しました。最新を取得し直してください。",
  "trap-regression": "発動済みの罠を取り消すチェックポイントは保存できません。",
  "elapsed-regression": "経過時間を巻き戻すチェックポイントは保存できません。",
  "pos-regression": "進行位置を巻き戻すチェックポイントは保存できません。",
} as const satisfies Record<CheckpointRejectionReason, string>;

/**
 * 受け付けるリクエスト本文の上限。dataの64KBに、封筒（view・pos・JSONの記法）の
 * 余裕を足した幅にする。上限を超える本文は、オブジェクトへ展開する前に413で返す。
 */
const CHECKPOINT_BODY_MAX_BYTES = 96 * 1024;

type CheckpointParseFailure = "invalid" | "data-too-large" | "body-too-large";

type ParsedCheckpointCommand =
  | { ok: true; command: SaveCheckpointCommand }
  | { ok: false; reason: CheckpointParseFailure };

/**
 * checkpointコマンドの検証を、失敗も例外もまとめてHTTP応答へ写せる形にする。
 * safeParseは値によっては例外を投げうる（深い入れ子など、検証自体が失敗する入力）ので、
 * 呼び出し側のtryの外に置かず、ここで捕まえて未処理例外にしない。
 */
const parseSaveCheckpointCommand = (input: unknown): ParsedCheckpointCommand => {
  try {
    const parsed = saveCheckpointCommandSchema.safeParse(input);
    if (parsed.success) return { ok: true, command: parsed.data };
    const tooLarge = parsed.error.issues.some(
      (issue) => issue.message === CHECKPOINT_DATA_TOO_LARGE_MESSAGE,
    );
    return { ok: false, reason: tooLarge ? "data-too-large" : "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
};

/** 本文の読み取り自体の失敗を、大きすぎる（413）と壊れている（400）へ振り分ける。 */
const failedToReadBody = (caught: unknown): ParsedCheckpointCommand => ({
  ok: false,
  reason: caught instanceof PayloadTooLargeError ? "body-too-large" : "invalid",
});

/**
 * ステージ内状態のチェックポイントを保存する。`nowIso`はここで採る——DOはテストから
 * Clockを差し替えられないため、時刻の境界をWorker側のhandlerに置いている。
 */
export const handleSaveCheckpoint = async (
  request: Request,
  env: Env,
  teamCode: TeamCode,
  nowIso: string = new Date().toISOString(),
): Promise<Response> => {
  const parsed = await parseJson(request, CHECKPOINT_BODY_MAX_BYTES).then(
    parseSaveCheckpointCommand,
    failedToReadBody,
  );
  if (!parsed.ok) {
    // 上限超過だけは他のschema違反と区別する——クライアントは書式ではなく
    // 保存する状態そのものを削る必要があるため。
    if (parsed.reason === "body-too-large") return error("リクエスト本文が大きすぎます。", 413);
    return parsed.reason === "data-too-large"
      ? error("チェックポイントのデータが大きすぎます。", 400)
      : error("checkpointの形式が不正です。", 400);
  }
  // 送信前PIIゲート（企画書§7）。深さと大きさの検査（schema）を通した後、DOへ触れる
  // 前に置く。チェックポイントのdataは復帰時にそのまま画面へ戻す正典データなので、
  // 活動ログのようにredactionで潰すと復帰そのものが壊れる。ここは拒否へ倒し、
  // クライアントに書き直させる（チャットの送信前ゲートと同じ"pii_blocked"）。
  // 何も保存しないので、DOにもチェックポイントにも台帳にも1行も書かない。
  if (containsPii(parsed.command.body.data)) {
    return error(
      "個人情報を検知したため、チェックポイントの保存をブロックしました。",
      422,
      "pii_blocked",
    );
  }
  try {
    const result = await env.TEAM_ROOM.getByName(teamCode).saveCheckpoint(
      teamCode,
      parsed.command,
      nowIso,
    );
    // 拒否理由はcodeにも載せる。クライアントは日本語文言ではなくこの値で分岐する。
    if ("rejected" in result)
      return error(CHECKPOINT_REJECTION_MESSAGES[result.rejected], 409, result.rejected);
    return json(saveCheckpointResultSchema.parse({ snapshot: result }));
  } catch {
    return error("チェックポイントの保存に失敗しました。時間を置いて再試行してください。", 503);
  }
};

export const handleCheckpointState = async (
  env: Env,
  teamCode: TeamCode,
  nowIso: string = new Date().toISOString(),
): Promise<Response> => {
  try {
    const checkpoint = await env.TEAM_ROOM.getByName(teamCode).loadCheckpoint(teamCode);
    return json(checkpointStateSchema.parse({ checkpoint, serverNow: nowIso }));
  } catch {
    return error("チェックポイントの取得に失敗しました。時間を置いて再試行してください。", 503);
  }
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
    return handleChatMessage(request, scope, messagesTeamCode, {
      aiGateway: createAiGateway(env),
      nowMs: Date.now(),
    });
  const checkpointTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/checkpoint");
  if (checkpointTeamCode !== null) return handleSaveCheckpoint(request, env, checkpointTeamCode);
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
  const checkpointTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/checkpoint");
  if (checkpointTeamCode !== null) return handleCheckpointState(env, checkpointTeamCode);
  return url.pathname === "/api/leaderboard/sync"
    ? handleLeaderboardSync(request, env)
    : Promise.resolve(new Response("Not found", { status: 404 }));
};

/**
 * 公開APIの入口ガード。`/api/*`（`/api/health`を除く）すべてに、メソッドや
 * WebSocket upgradeの別なく一律で当てる。前作Hell-AI-v2では書き込み系だけを
 * 検証したため管理系APIに検証漏れが残った。拒否したときはDOにもAiGatewayにも触れない。
 *
 * Origin検証はブラウザ経由の悪用（CSRF・他サイトからの読み取り）を止める層であって、
 * 認証ではない。非ブラウザからの直接アクセスはOriginを詐称できるため、そちらは
 * TEAM_CODESの許可リストとレート制限で抑える（詳細はguard.ts先頭の注記）。
 *
 * 通す場合はnullを返す。
 */
/**
 * ヘルスチェックへ載せる運用値の状態。デプロイ後に`GET /api/health`を見るだけで
 * 設定漏れが分かるようにする——TEAM_CODES未設定のfail-openは意図した既定であり、
 * 本番でそのまま残っていても例外やログには現れないため、目視できる形で出す。
 * 値そのもの（配布したチームコードや許可オリジン）は伏せ、設定の有無だけを返す。
 */
const guardStatus = (env: Env): Record<string, boolean | number> => ({
  teamCodes: parseTeamCodes(env.TEAM_CODES) !== null,
  allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS).length > 0,
  chatRateLimitPerMinute: parseChatRateLimit(env.CHAT_RATE_LIMIT_PER_MINUTE),
});

/**
 * 許可リストを当てる対象のチームコードを取り出す。`/api/teams/:code/*`はパスから、
 * `/api/leaderboard/sync`はクエリから読む（リーダーボードのDOはグローバル1つで、
 * チームコードはクエリでしか渡ってこない）。
 */
const guardedTeamCode = (url: URL): TeamCode | null =>
  url.pathname === "/api/leaderboard/sync"
    ? (teamCodeSchema.safeParse(url.searchParams.get("teamCode")).data ?? null)
    : teamCodeFromApiPath(url.pathname);

const guardApiRequest = (request: Request, env: Env, url: URL): Response | null => {
  if (!url.pathname.startsWith("/api/")) return null;
  // ヘルスチェックは配信元の生死確認用で、モックが起動時に無条件で叩く。Origin不問にする。
  if (url.pathname === "/api/health") return null;
  if (!isApiRequestAllowed(request, url, parseAllowedOrigins(env.ALLOWED_ORIGINS))) {
    return error("許可されていない送信元からのリクエストです。", 403);
  }
  const teamCode = guardedTeamCode(url);
  if (teamCode !== null && !isTeamCodeAllowed(teamCode, parseTeamCodes(env.TEAM_CODES))) {
    // 未登録コードの存在を明かさないよう、経路自体が無いときと同じ404に揃える。
    return new Response("Not found", { status: 404 });
  }
  return null;
};

/**
 * ブラウザのpreflightへの応答。本APIが受けるのはGETとPOSTだけで、独自ヘッダーも
 * 使わないため、許可するmethodとheaderはこの2つに絞る。Max-Ageで再問い合わせを
 * 1日に1回へ抑える（研修は120分なので実質1回で済む）。
 */
const preflightResponse = (cors: CorsHeaders): Response =>
  new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });

/**
 * 応答へCORSヘッダーを足す。`cors`が空（同一オリジン、または許可外）なら素通しする。
 * WebSocketの101応答は本体を作り直せないので触らない。
 */
const withCors = (response: Response, cors: CorsHeaders): Response => {
  if (response.webSocket !== null || Object.keys(cors).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/** 入口ガードを通したうえで、メソッド別のハンドラーへ振り分ける。 */
const routeRequest = (
  request: Request,
  scope: RequestScope,
  url: URL,
  cors: CorsHeaders,
): Promise<Response> => {
  const { env } = scope;
  const blocked = guardApiRequest(request, env, url);
  if (blocked !== null) return Promise.resolve(blocked);
  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/"))
    return Promise.resolve(preflightResponse(cors));
  if (request.method === "GET" && url.pathname === "/api/health")
    return Promise.resolve(json({ status: "ok", guards: guardStatus(env) }));
  if (request.method === "POST") return handlePost(request, scope, url);
  if (request.method === "GET") return handleGet(request, env, url);
  return Promise.resolve(new Response("Not found", { status: 404 }));
};

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // 許可判定はcorsHeadersFor自身がもう一度行う。ガードで403にならなかった
    // リクエストでも、同一オリジンや許可外にはヘッダーが付かない。
    const cors = url.pathname.startsWith("/api/")
      ? corsHeadersFor(request.headers.get("Origin"), url, parseAllowedOrigins(env.ALLOWED_ORIGINS))
      : {};
    return withCors(await routeRequest(request, { env, ctx }, url, cors), cors);
  },
} satisfies ExportedHandler<Env>;

export default worker;
