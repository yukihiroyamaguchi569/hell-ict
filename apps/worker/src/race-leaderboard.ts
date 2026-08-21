import { leaderboardSnapshotSchema, teamCodeSchema, teamSnapshotSchema } from "@hell-ict/domain";
import type { LeaderboardSnapshot, TeamCode } from "@hell-ict/domain";
import { DurableObject } from "cloudflare:workers";

import { error, isWebSocketRequest } from "./http.js";

type StoredLeaderboard = { team_code: string; team_revision: number; stage: "prologue" | "stage1" };
type StoredRevision = { revision: number };

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
