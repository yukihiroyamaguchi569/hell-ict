import {
  prepareStageThreadCommandSchema,
  sha256Hex,
  stableStringify,
  teamGameCommandSchema,
  teamGamePosition,
} from "@hell-ict/domain";
import type { StageAi, TeamCode, TeamGameCommand, TeamGameState } from "@hell-ict/domain";
import type { Clock } from "@hell-ict/domain/ports";

import { gameCommandRpcResultSchema, gameViewRpcResultSchema } from "./game-store.js";
import type { GameCommandReply } from "./game-store.js";
import { bodyErrorResponse, error, json, parseJson, staleGenerationResponse } from "./http.js";
import type { RequestScope } from "./http.js";

/**
 * ゲーム状態のAPI（Issue #234）。
 * - `GET  /api/teams/:code/game`: 現在の状態。再接続した画面はここから組み立て直す。
 * - `POST /api/teams/:code/game/commands`: 画面のコマンド1つ。commandIdで冪等。
 * - `GET  /api/teams/:code/game/leaderboard`: ゲーム状態から見た順位。
 *
 * 判定はサーバの時計で行う。時計はここ（Workerのハンドラ）で1回だけ読んでDOへ渡す
 * ——DOはテストから時計を差し替えられないので、境界をWorker側に置いて、テストでは
 * Fake Clockを渡す（チェックポイントのnowIsoと同じ流儀）。
 */

export const systemClock: Clock = { now: () => new Date() };

/**
 * 画面へ返す状態。D1の処理済みcommandIdの一覧は台帳の内側の都合で、画面は使わないので
 * 外す（遷移のたびに伸びる）。`pos`は帯の停留所、`serverNow`はサーバの時計（epoch ms）で、
 * 画面は締切のカウントダウンをこれに合わせる（domainのestimateServerOffsetMs）。
 * `ai`は今のステージのAI（Issue #236）。画面はこの`threadId`の会話だけを出し、`failed`なら
 * 会話の準備に失敗したことを示して再試行させる（Issue #85）。
 */
export const gameView = (state: TeamGameState, nowMs: number, ai: StageAi) => {
  const { processedCommandIds, ...game } = state.game;
  void processedCommandIds;
  return { state: { ...state, game }, pos: teamGamePosition(state), serverNow: nowMs, ai };
};

export const handleGameState = async (
  env: Env,
  teamCode: TeamCode,
  clock: Clock = systemClock,
): Promise<Response> => {
  const nowMs = clock.now().getTime();
  try {
    const room = env.TEAM_ROOM.getByName(teamCode);
    // RPCの境界なので、返ってきた状態もschemaで検証してから使う。
    const { state, ai } = gameViewRpcResultSchema.parse(await room.gameState(teamCode, nowMs));
    return json(gameView(state, nowMs, ai));
  } catch {
    return error("ゲーム状態の取得に失敗しました。時間を置いて再試行してください。", 503);
  }
};

/** 適用・拒否・再送の結果を、画面へ返す本文へ写す。 */
const replyBody = (reply: GameCommandReply, nowMs: number, ai: StageAi) => {
  const view = gameView(reply.state, nowMs, ai);
  switch (reply.kind) {
    case "applied":
      return { status: "applied", events: reply.events, judgement: reply.judgement, ...view };
    case "rejected":
      return { status: "rejected", reason: reply.reason, judgement: reply.judgement, ...view };
    case "duplicate":
      // 同じcommandIdの再送。状態は動かさず、最初に適用したときの判定とeventsを添える。
      return { status: "duplicate", original: reply.original, ...view };
  }
};

/**
 * 本文を読み、schemaで検証する。提出本文（S5の一覧など）はここから先、判定に使うだけで
 * どこにも保存しない。指紋（SHA-256）だけを冪等台帳に残す。
 */
const parseCommand = async (
  request: Request,
): Promise<{ ok: true; command: TeamGameCommand } | { ok: false; response: Response }> => {
  try {
    const parsed = teamGameCommandSchema.safeParse(await parseJson(request));
    return parsed.success
      ? { ok: true, command: parsed.data }
      : { ok: false, response: error("commandの形式が不正です。", 400) };
  } catch (caught) {
    return { ok: false, response: bodyErrorResponse(caught, "commandの形式が不正です。") };
  }
};

/**
 * `POST /api/teams/:code/game/commands`: 画面のコマンド1つ。commandIdで冪等。
 * 本文はapplied・rejected・duplicateのどれでも200で返し、`status`で分ける（rejectedは
 * 何も変えていないので、条件が整えば同じcommandIdで送り直せる）。
 */
export const handleGameCommand = async (
  request: Request,
  scope: RequestScope,
  teamCode: TeamCode,
  clock: Clock = systemClock,
): Promise<Response> => {
  const parsed = await parseCommand(request);
  if (!parsed.ok) return parsed.response;
  const nowMs = clock.now().getTime();
  try {
    const fingerprint = await sha256Hex(stableStringify(parsed.command));
    const room = scope.env.TEAM_ROOM.getByName(teamCode);
    const result = gameCommandRpcResultSchema.parse(
      await room.applyGameCommand(teamCode, parsed.command, nowMs, fingerprint),
    );
    if ("staleGeneration" in result) return staleGenerationResponse();
    if ("conflict" in result)
      return error("同じ送信IDが別の内容で使われています。", 409, "conflict");
    return json(replyBody(result.reply, nowMs, result.ai));
  } catch {
    return error("コマンドの処理に失敗しました。時間を置いて再試行してください。", 503);
  }
};

/**
 * `POST /api/teams/:code/game/chat/thread`: 今のステージの会話の準備をやり直す（Issue #85）。
 * 本文は`{ type: "prepare-stage-thread", generation }`。何度送っても会話は1本しか増えないので
 * commandIdは持たない。応答はGETと同じ形で、`ai.status`が`ready`になっていれば準備できた。
 */
export const handlePrepareStageThread = async (
  request: Request,
  env: Env,
  teamCode: TeamCode,
  clock: Clock = systemClock,
): Promise<Response> => {
  let generation: number;
  try {
    generation = prepareStageThreadCommandSchema.parse(await parseJson(request)).generation;
  } catch (caught) {
    return bodyErrorResponse(caught, "commandの形式が不正です。");
  }
  const nowMs = clock.now().getTime();
  try {
    const room = env.TEAM_ROOM.getByName(teamCode);
    const result = await room.prepareStageThread(teamCode, generation, nowMs);
    if ("staleGeneration" in result) return staleGenerationResponse();
    const { state, ai } = gameViewRpcResultSchema.parse(result);
    return json(gameView(state, nowMs, ai));
  } catch {
    return error("会話の準備に失敗しました。時間を置いて再試行してください。", 503);
  }
};

/** `GET /api/teams/:code/game/leaderboard`: ゲーム状態から見た順位。 */
export const handleGameStandings = async (env: Env, teamCode: TeamCode): Promise<Response> => {
  try {
    return json(await env.RACE_LEADERBOARD.getByName("global").gameStandings(teamCode));
  } catch {
    return error("順位の取得に失敗しました。時間を置いて再試行してください。", 503);
  }
};
