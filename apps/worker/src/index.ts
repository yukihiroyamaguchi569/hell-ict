import {
  commandResultSchema,
  initialTeamSnapshot,
  leaderboardSnapshotSchema,
  teamCodeSchema,
  teamCommandSchema,
  teamSnapshotSchema,
  transitionTeam,
} from "@hell-ict/domain";
import type {
  CommandResult,
  LeaderboardSnapshot,
  TeamCode,
  TeamCommand,
  TeamSnapshot,
} from "@hell-ict/domain";
import { DurableObject } from "cloudflare:workers";

type StoredCommand = { result: string };
type StoredState = { snapshot: string };
type StoredLeaderboard = { team_code: string; team_revision: number; stage: "prologue" | "stage1" };
type StoredRevision = { revision: number };
type ConflictReply = { conflict: true };

const json = (value: unknown, status = 200): Response => Response.json(value, { status });
const error = (message: string, status: number): Response => json({ message }, status);
const parseJson = async (request: Request): Promise<unknown> => request.json();
const isWebSocketRequest = (request: Request): boolean =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";
const teamCodeFromPath = (pathname: string, suffix: string): TeamCode | null => {
  const prefix = "/api/teams/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  return teamCodeSchema.safeParse(pathname.slice(prefix.length, -suffix.length)).data ?? null;
};

export class RaceLeaderboard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS leaderboard_entries (team_code TEXT PRIMARY KEY, team_revision INTEGER NOT NULL, stage TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS leaderboard_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO leaderboard_meta (key, value) VALUES ('revision', 0)",
    );
  }

  async upsert(teamCodeInput: unknown, snapshotInput: unknown): Promise<LeaderboardSnapshot> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const snapshot = teamSnapshotSchema.parse(snapshotInput);
    if (teamCode !== snapshot.teamCode) throw new Error("チームコードが一致しません。");
    const existing =
      this.ctx.storage.sql
        .exec<StoredLeaderboard>(
          "SELECT team_code, team_revision, stage FROM leaderboard_entries WHERE team_code = ?",
          teamCode,
        )
        .toArray()[0] ?? null;
    if (existing !== null && existing.team_revision >= snapshot.revision)
      return this.snapshotFor(teamCode);
    this.ctx.storage.sql.exec(
      "INSERT INTO leaderboard_entries (team_code, team_revision, stage) VALUES (?, ?, ?) ON CONFLICT(team_code) DO UPDATE SET team_revision = excluded.team_revision, stage = excluded.stage",
      teamCode,
      snapshot.revision,
      snapshot.state.stage,
    );
    this.ctx.storage.sql.exec(
      "UPDATE leaderboard_meta SET value = value + 1 WHERE key = 'revision'",
    );
    this.broadcast();
    return this.snapshotFor(teamCode);
  }

  override async fetch(request: Request): Promise<Response> {
    if (!isWebSocketRequest(request)) return error("WebSocket接続が必要です。", 426);
    const parsed = teamCodeSchema.safeParse(new URL(request.url).searchParams.get("teamCode"));
    if (!parsed.success) return error("teamCodeはASCII数字6桁で指定してください。", 400);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ kind: "leaderboard", teamCode: parsed.data });
    this.ctx.acceptWebSocket(server);
    this.send(server, this.snapshotFor(parsed.data));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    void socket;
    void message;
  }
  override webSocketClose(socket: WebSocket): void {
    socket.close();
  }

  private readEntries(): { revision: number; rows: StoredLeaderboard[] } {
    const meta = this.ctx.storage.sql
      .exec<StoredRevision>("SELECT value AS revision FROM leaderboard_meta WHERE key = 'revision'")
      .one();
    const rows = this.ctx.storage.sql
      .exec<StoredLeaderboard>(
        "SELECT team_code, team_revision, stage FROM leaderboard_entries ORDER BY team_revision DESC, team_code ASC",
      )
      .toArray();
    return { revision: meta?.revision ?? 0, rows };
  }

  private snapshotFrom(
    entries: { revision: number; rows: StoredLeaderboard[] },
    teamCode: TeamCode,
  ): LeaderboardSnapshot {
    return leaderboardSnapshotSchema.parse({
      revision: entries.revision,
      entries: entries.rows.map((row, index) => ({
        marker: `チーム${index + 1}`,
        isSelf: row.team_code === teamCode,
        stage: row.stage,
        teamRevision: row.team_revision,
      })),
    });
  }

  private snapshotFor(teamCode: TeamCode): LeaderboardSnapshot {
    return this.snapshotFrom(this.readEntries(), teamCode);
  }

  private broadcast(): void {
    const entries = this.readEntries();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      const teamCode =
        typeof attachment === "object" && attachment !== null && "teamCode" in attachment
          ? teamCodeSchema.safeParse(attachment.teamCode)
          : teamCodeSchema.safeParse(undefined);
      if (teamCode.success) this.send(socket, this.snapshotFrom(entries, teamCode.data));
    }
  }

  private send(socket: WebSocket, snapshot: LeaderboardSnapshot): void {
    try {
      socket.send(JSON.stringify(snapshot));
    } catch {
      socket.close(1011, "配信に失敗しました。");
    }
  }
}

export class TeamRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS team_state (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS processed_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL)",
    );
  }

  async join(teamCodeInput: unknown): Promise<TeamSnapshot> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const stored =
      this.ctx.storage.sql
        .exec<StoredState>("SELECT snapshot FROM team_state WHERE id = 1")
        .toArray()[0] ?? null;
    if (stored !== null) return teamSnapshotSchema.parse(JSON.parse(stored.snapshot) as unknown);
    const snapshot = initialTeamSnapshot(teamCode);
    this.ctx.storage.sql.exec(
      "INSERT INTO team_state (id, snapshot) VALUES (1, ?)",
      JSON.stringify(snapshot),
    );
    return snapshot;
  }

  async command(
    teamCodeInput: unknown,
    commandInput: unknown,
  ): Promise<CommandResult | ConflictReply> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const command = teamCommandSchema.parse(commandInput);
    const saved =
      this.ctx.storage.sql
        .exec<StoredCommand>(
          "SELECT result FROM processed_commands WHERE command_id = ?",
          command.commandId,
        )
        .toArray()[0] ?? null;
    if (saved !== null)
      return this.repair(
        commandResultSchema.parse(JSON.parse(saved.result) as unknown),
        command.commandId,
      );
    const transition = transitionTeam(await this.join(teamCode), command);
    if (!transition.ok) return { conflict: true };
    const pending = commandResultSchema.parse({
      snapshot: transition.snapshot,
      applied: true,
      leaderboardPending: true,
    });
    const written = this.ctx.storage.sql.exec(
      "UPDATE team_state SET snapshot = ? WHERE id = 1 AND json_extract(snapshot, '$.revision') = ?",
      JSON.stringify(pending.snapshot),
      command.expectedRevision,
    ).rowsWritten;
    if (written === 0) return { conflict: true };
    this.ctx.storage.sql.exec(
      "INSERT INTO processed_commands (command_id, result) VALUES (?, ?)",
      command.commandId,
      JSON.stringify(pending),
    );
    return this.repair(pending, command.commandId);
  }

  override async fetch(request: Request): Promise<Response> {
    if (!isWebSocketRequest(request)) return error("WebSocket接続が必要です。", 426);
    const parsed = teamCodeSchema.safeParse(new URL(request.url).searchParams.get("teamCode"));
    if (!parsed.success) return error("teamCodeはASCII数字6桁で指定してください。", 400);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ kind: "team", teamCode: parsed.data });
    this.ctx.acceptWebSocket(server);
    this.send(server, await this.join(parsed.data));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    void socket;
    void message;
  }
  override webSocketClose(socket: WebSocket): void {
    socket.close();
  }

  private async repair(result: CommandResult, commandId: string): Promise<CommandResult> {
    if (result.leaderboardPending) {
      try {
        await this.env.RACE_LEADERBOARD.getByName("global").upsert(
          result.snapshot.teamCode,
          result.snapshot,
        );
      } catch {
        return result;
      }
      const completed = commandResultSchema.parse({ ...result, leaderboardPending: false });
      this.ctx.storage.sql.exec(
        "UPDATE processed_commands SET result = ? WHERE command_id = ?",
        JSON.stringify(completed),
        commandId,
      );
      this.broadcast(completed.snapshot);
      return completed;
    }
    return result;
  }

  private broadcast(snapshot: TeamSnapshot): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, snapshot);
  }
  private send(socket: WebSocket, snapshot: TeamSnapshot): void {
    try {
      socket.send(JSON.stringify(snapshot));
    } catch {
      socket.close(1011, "配信に失敗しました。");
    }
  }
}

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
  const teamCode = teamCodeFromPath(url.pathname, "/commands");
  return teamCode === null
    ? Promise.resolve(new Response("Not found", { status: 404 }))
    : handleCommand(request, env, teamCode);
};

const handleGet = (request: Request, env: Env, url: URL): Promise<Response> => {
  const teamCode = teamCodeFromPath(url.pathname, "/sync");
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
