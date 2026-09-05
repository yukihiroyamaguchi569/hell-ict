import {
  leaderboardEntrySchema,
  leaderboardSnapshotSchema,
  resetGenerationSchema,
  revisionSchema,
  teamCodeSchema,
  teamSnapshotSchema,
} from "@hell-ict/domain";
import type { LeaderboardSnapshot, TeamCode } from "@hell-ict/domain";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { isTeamCodeAllowed, parseTeamCodeRule } from "./guard.js";
import { error, isWebSocketRequest } from "./http.js";
import { isDuplicateColumn } from "./sqlite.js";

/**
 * leaderboard_entriesの行。SQLiteは列の型を強制しないので、読み出しも実行時に検証する。
 *
 * 壊れた行は配信全体を止めずスキップする——ここで例外にすると、1チームの1行が壊れた
 * だけで全購読者の帯が更新されなくなる。レースの表示は「1チームが欠ける」ほうが
 * 「全員の画面が止まる」より害が小さい。
 */
const storedLeaderboardSchema = z.object({
  team_code: teamCodeSchema,
  team_revision: revisionSchema,
  stage: leaderboardEntrySchema.shape.stage,
});

/** フェンスの行。壊れていたら0として扱い、配信も更新も止めない。 */
const storedFenceSchema = z.object({ generation: resetGenerationSchema });

type StoredLeaderboard = z.infer<typeof storedLeaderboardSchema>;

/** meta.revisionも同じ理由で、壊れていたら0として扱い配信は続ける。 */
const storedRevisionSchema = z.object({ revision: revisionSchema });

export class RaceLeaderboard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS leaderboard_entries (team_code TEXT PRIMARY KEY, team_revision INTEGER NOT NULL, stage TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS leaderboard_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
    );
    // リセットのフェンス。行を消しても残す——消してしまうと、リセット直前に
    // snapshotを読んだ入室の遅れたupsertが、古い段階の行を作り直せてしまう。
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS leaderboard_fences (team_code TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
    );
    // 既にテーブルを持つDOには列を後から足す。2度目以降は必ず「列が既にある」で
    // 失敗するので、その1種類だけを握る。ほかの失敗まで握ると、列の無いまま
    // コンストラクタが通り、以後upsertが世代を書けないまま動き続ける。
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE leaderboard_entries ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
      );
    } catch (caught) {
      if (!isDuplicateColumn(caught)) throw caught;
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO leaderboard_meta (key, value) VALUES ('revision', 0)",
    );
  }

  async upsert(
    teamCodeInput: unknown,
    snapshotInput: unknown,
    generationInput: unknown,
  ): Promise<LeaderboardSnapshot> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const snapshot = teamSnapshotSchema.parse(snapshotInput);
    const generation = resetGenerationSchema.parse(generationInput);
    if (teamCode !== snapshot.teamCode) throw new Error("チームコードが一致しません。");
    // リセットより前に読まれたsnapshotの、遅れて届いたupsert。行を作り直させない
    // ——revisionの比較では守れない（行が消えているので、どんな古い値も「新しい」）。
    if (generation < this.fenceFor(teamCode)) return this.snapshotFor(teamCode);
    // 既存行も読み出し時に検証する。型指定だけで信用すると、壊れた巨大な
    // team_revisionが入っていた場合に以後の正常な更新がすべて「古い」と判定され、
    // そのチームの帯が二度と進まなくなる。壊れていれば行が無かったものとして
    // 上書きし、次のupsertで正常な値へ戻す。
    const existing =
      this.ctx.storage.sql
        .exec(
          "SELECT team_code, team_revision, stage FROM leaderboard_entries WHERE team_code = ?",
          teamCode,
        )
        .toArray()
        .map((row) => storedLeaderboardSchema.safeParse(row).data)
        .filter((row) => row !== undefined)[0] ?? null;
    if (existing !== null && existing.team_revision >= snapshot.revision)
      return this.snapshotFor(teamCode);
    this.ctx.storage.sql.exec(
      "INSERT INTO leaderboard_entries (team_code, team_revision, stage, generation) VALUES (?, ?, ?, ?) ON CONFLICT(team_code) DO UPDATE SET team_revision = excluded.team_revision, stage = excluded.stage, generation = excluded.generation",
      teamCode,
      snapshot.revision,
      snapshot.state.stage,
      generation,
    );
    this.ctx.storage.sql.exec(
      "UPDATE leaderboard_meta SET value = value + 1 WHERE key = 'revision'",
    );
    this.broadcast();
    return this.snapshotFor(teamCode);
  }

  /**
   * ゲームマスターのリセットで、そのチームの行を落とす（`POST /api/gm/teams/.../reset`）。
   * 初期位置の行を書き戻すのではなく消す——次の入室で`/api/session`がupsertし、
   * revision 0・prologueの行として作り直されるので、消しておくほうが状態が1つ少ない。
   *
   * revisionを進めて配信し直すのは、既に帯を購読している端末から、消した行が
   * 消えたことが見えるようにするためである。
   */
  async resetTeam(
    teamCodeInput: unknown,
    generationInput: unknown,
  ): Promise<{ readonly ok: true }> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const generation = resetGenerationSchema.parse(generationInput);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM leaderboard_entries WHERE team_code = ?", teamCode);
      // フェンスは単調に上げる。古いリセットの再送で下げると、いったん弾いた
      // 遅れたupsertがもう一度通る窓が開く。
      this.ctx.storage.sql.exec(
        "INSERT INTO leaderboard_fences (team_code, generation) VALUES (?, ?) ON CONFLICT(team_code) DO UPDATE SET generation = MAX(generation, excluded.generation)",
        teamCode,
        generation,
      );
      this.ctx.storage.sql.exec(
        "UPDATE leaderboard_meta SET value = value + 1 WHERE key = 'revision'",
      );
    });
    this.broadcast();
    return { ok: true };
  }

  /**
   * そのチームの下限世代。リセットしていなければ0（＝どのupsertも通る）。
   * 行が壊れていたら0として扱い、配信ごと止めない（storedLeaderboardSchemaと同じ方針）。
   */
  private fenceFor(teamCode: TeamCode): number {
    const row =
      this.ctx.storage.sql
        .exec("SELECT generation FROM leaderboard_fences WHERE team_code = ?", teamCode)
        .toArray()[0] ?? null;
    return row === null ? 0 : (storedFenceSchema.safeParse(row).data?.generation ?? 0);
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

  /**
   * 配信する行を読む。EVENT_NOを設定したら、規則に合わないチームは配信から外す
   * ——設定前に試験で入れたコードや前回開催のチームがleaderboard_entriesに残っており、
   * そのままだと当日の帯にゴーストとして並ぶ。行そのものは消さない（設定を戻せば
   * また見える。掃除は運用の判断に委ねる）。
   *
   * 設定が不正（invalid）なら空を配信する。他のガードと同じくfail-closedへ倒し、
   * 「設定したつもりで全部見えている」を作らない。
   */
  private readEntries(): { revision: number; rows: StoredLeaderboard[] } {
    const meta = this.ctx.storage.sql
      .exec("SELECT value AS revision FROM leaderboard_meta WHERE key = 'revision'")
      .toArray()[0];
    const rule = parseTeamCodeRule(this.env);
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT team_code, team_revision, stage FROM leaderboard_entries ORDER BY team_revision DESC, team_code ASC",
      )
      .toArray()
      .map((row) => storedLeaderboardSchema.safeParse(row).data)
      .filter((row) => row !== undefined)
      .filter((row) => isTeamCodeAllowed(row.team_code, rule));
    return { revision: storedRevisionSchema.safeParse(meta).data?.revision ?? 0, rows };
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
