import {
  gameCommandResponseSchema,
  gameViewResponseSchema,
  sessionResultSchema,
} from "@hell-ict/domain";
import type {
  GameCommandResponse,
  GameViewResponse,
  SessionResult,
  TeamCode,
  TeamGameCommand,
} from "@hell-ict/domain";

import type { HttpPort } from "../ports.js";
import { getJson, postJson } from "./http.js";
import type { ApiResult } from "./http.js";

/** The game API of the Worker (`apps/worker/src/game-api.ts`), one function per route. */
export interface GameApi {
  /** `POST /api/session`: joins the team. Only this answer carries the reset generation. */
  openSession(teamCode: TeamCode): Promise<ApiResult<SessionResult>>;
  /** `GET /api/teams/:code/game`: the game as the server has it now. */
  fetchGame(teamCode: TeamCode): Promise<ApiResult<GameViewResponse>>;
  /** `POST /api/teams/:code/game/commands`: one command, idempotent by its commandId. */
  sendCommand(
    teamCode: TeamCode,
    command: TeamGameCommand,
  ): Promise<ApiResult<GameCommandResponse>>;
  /**
   * `POST /api/teams/:code/game/chat/thread`: asks the server again to prepare the current
   * stage's conversation (after `ai.status` came back `failed`). Answers like `fetchGame`.
   */
  prepareStageThread(teamCode: TeamCode, generation: number): Promise<ApiResult<GameViewResponse>>;
}

export const createGameApi = (http: HttpPort): GameApi => ({
  openSession: (teamCode) => postJson(http, "/api/session", { teamCode }, sessionResultSchema),
  fetchGame: (teamCode) => getJson(http, `/api/teams/${teamCode}/game`, gameViewResponseSchema),
  sendCommand: (teamCode, command) =>
    postJson(http, `/api/teams/${teamCode}/game/commands`, command, gameCommandResponseSchema),
  prepareStageThread: (teamCode, generation) =>
    postJson(
      http,
      `/api/teams/${teamCode}/game/chat/thread`,
      { type: "prepare-stage-thread", generation },
      gameViewResponseSchema,
    ),
});
