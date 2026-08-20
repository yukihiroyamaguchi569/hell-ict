import {
  createThreadCommandSchema,
  sendMessageCommandSchema,
  teamCodeSchema,
  teamCommandSchema,
} from "@hell-ict/domain";
import type {
  AiGateway,
  CreateThreadCommand,
  CreateThreadResult,
  SendMessageCommand,
  TeamCode,
  TeamCommand,
} from "@hell-ict/domain";

import { error, isWebSocketRequest, json, parseJson, teamCodeFromPath } from "./http.js";
import { createAiGateway } from "./openai-gateway.js";
import { RaceLeaderboard } from "./race-leaderboard.js";
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

const handleCreateThread = async (
  request: Request,
  env: Env,
  teamCode: TeamCode,
): Promise<Response> => {
  let command: CreateThreadCommand;
  try {
    command = createThreadCommandSchema.parse(await parseJson(request));
  } catch {
    return error("commandの形式が不正です。", 400);
  }
  try {
    const result: CreateThreadResult = await env.TEAM_ROOM.getByName(teamCode).createThread(
      teamCode,
      command,
    );
    return json(result);
  } catch {
    return error("スレッドの作成に失敗しました。時間を置いて再試行してください。", 503);
  }
};

export const handleChatMessage = async (
  request: Request,
  env: Env,
  teamCode: TeamCode,
  aiGateway: AiGateway,
): Promise<Response> => {
  let command: SendMessageCommand;
  try {
    command = sendMessageCommandSchema.parse(await parseJson(request));
  } catch {
    return error("commandの形式が不正です。", 400);
  }

  const room = env.TEAM_ROOM.getByName(teamCode);
  const begin = await room.beginChatMessage(teamCode, command).catch(() => null);
  if (begin === null)
    return error("メッセージの処理に失敗しました。時間を置いて再試行してください。", 503);
  if ("unknownThread" in begin) return error("指定されたスレッドが見つかりません。", 404);
  if (begin.kind === "already-processed") return json(begin.result);

  const response = await aiGateway
    .complete({ messages: begin.history, timeoutMs: CHAT_TIMEOUT_MS })
    .catch(() => null);
  const outcome: { kind: "success"; text: string } | { kind: "failure" } =
    response === null ? { kind: "failure" } : { kind: "success", text: response.text };

  const result = await room.completeChatMessage(command.commandId, outcome).catch(() => null);
  if (result === null)
    return error("応答の保存に失敗しました。時間を置いて再試行してください。", 503);
  if ("retry" in result) return error("AI応答の取得に失敗しました。再試行してください。", 503);
  return json(result);
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

const handlePost = (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.pathname === "/api/session") return handleSession(request, env);
  const threadsTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/chat/threads");
  if (threadsTeamCode !== null) return handleCreateThread(request, env, threadsTeamCode);
  const messagesTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/chat/messages");
  if (messagesTeamCode !== null)
    return handleChatMessage(request, env, messagesTeamCode, createAiGateway(env));
  const commandTeamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/commands");
  return commandTeamCode === null
    ? Promise.resolve(new Response("Not found", { status: 404 }))
    : handleCommand(request, env, commandTeamCode);
};

const handleGet = (request: Request, env: Env, url: URL): Promise<Response> => {
  const teamCode = teamCodeFromPath(url.pathname, "/api/teams/", "/sync");
  if (teamCode !== null) return handleTeamSync(request, env, teamCode);
  return url.pathname === "/api/leaderboard/sync"
    ? handleLeaderboardSync(request, env)
    : Promise.resolve(new Response("Not found", { status: 404 }));
};

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ status: "ok" });
    }
    if (request.method === "POST") return handlePost(request, env, url);
    if (request.method === "GET") return handleGet(request, env, url);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export default worker;
