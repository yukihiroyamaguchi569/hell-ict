import {
  leaderboardEntrySchema,
  leaderboardSnapshotSchema,
  resetGenerationSchema,
  revisionSchema,
  teamCodeSchema,
  teamGameStandingSchema,
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

/**
 * upsertが「採るか捨てるか」を決めるために読む既存行。世代をrevisionより先に見るので、
 * そこも読み出して検証する。壊れていれば行が無かったものとして扱い、上書きで直す。
 */
const storedEntryStateSchema = z.object({
  team_revision: revisionSchema,
  generation: resetGenerationSchema,
});

type StoredLeaderboard = z.infer<typeof storedLeaderboardSchema>;

/** game_standingsの行。壊れた行は配信全体を止めずスキップする（上と同じ方針）。 */
const storedStandingSchema = z.object({
  team_code: teamCodeSchema,
  stage: teamGameStandingSchema.shape.stage,
  pos: teamGameStandingSchema.shape.pos,
  reached_at: teamGameStandingSchema.shape.reachedAt,
  finished_at: teamGameStandingSchema.shape.finishedAt,
});

export const gameStandingsSnapshotSchema = z
  .object({
    entries: z.array(
      teamGameStandingSchema.extend({ marker: z.string().min(1), isSelf: z.boolean() }).strict(),
    ),
  })
  .strict();

export type GameStandingsSnapshot = z.infer<typeof gameStandingsSnapshotSchema>;

/** meta.revisionも同じ理由で、壊れていたら0として扱い配信は続ける。 */
const storedRevisionSchema = z.object({ revision: revisionSchema });

/**
 * 既存行に対して、このupsertを捨てるべきか。世代をrevisionより先に見る——リセットで
 * revisionは0へ戻るので、順序を逆にすると入り直したチームのupsertが古い行の大きい
 * revisionに負けて捨てられ、次の遷移まで帯から消える。
 *
 * - 保存済みより古い世代: revisionに関わらず捨てる。
 * - 新しい世代: revisionに関わらず上書きする（リセットで0へ戻っているため）。
 * - 同じ世代: 従来どおりrevisionの単調性で判断する。
 */
const supersededByExisting = (
  existing: z.infer<typeof storedEntryStateSchema> | null,
  generation: number,
  revision: number,
): boolean => {
  if (existing === null) return false;
  if (generation !== existing.generation) return generation < existing.generation;
  return existing.team_revision >= revision;
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
    // ゲーム状態（Issue #234）から見た各チームの位置。leaderboard_entries（入室時の
    // P1Bのsnapshot）とは別に持つ——あちらの形は/api/leaderboard/syncの既存の配信で、
    // 変えると既存APIが変わる。
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS game_standings (team_code TEXT PRIMARY KEY, generation INTEGER NOT NULL, seq INTEGER NOT NULL, stage TEXT NOT NULL, pos INTEGER NOT NULL, reached_at TEXT NOT NULL, finished_at TEXT)",
    );
  }

  /**
   * TeamRoomのゲーム状態が動いたときの位置を記録する。`seq`はそのチームでD1が適用した
   * コマンドの数で、遷移のたびに増える。反映は失敗すると後から送り直されるうえ、2つの
   * タブの反映が前後して届くこともあるので、同じ世代では`seq`が進んだものだけを採る
   * ——古い位置で新しい位置を上書きしない。世代の扱いはupsertと同じ（フェンスより古い
   * 世代は捨て、新しい世代は上書きする）。
   */
  async recordStanding(
    teamCodeInput: unknown,
    standingInput: unknown,
    seqInput: unknown,
    generationInput: unknown,
  ): Promise<{ readonly ok: true }> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const standing = teamGameStandingSchema.parse(standingInput);
    const seq = revisionSchema.parse(seqInput);
    const generation = resetGenerationSchema.parse(generationInput);
    if (generation < this.fenceFor(teamCode)) return { ok: true };
    this.ctx.storage.sql.exec(
      `INSERT INTO game_standings (team_code, generation, seq, stage, pos, reached_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_code) DO UPDATE SET generation = excluded.generation, seq = excluded.seq,
         stage = excluded.stage, pos = excluded.pos, reached_at = excluded.reached_at,
         finished_at = excluded.finished_at
       WHERE excluded.generation > game_standings.generation
          OR (excluded.generation = game_standings.generation AND excluded.seq > game_standings.seq)`,
      teamCode,
      generation,
      seq,
      standing.stage,
      standing.pos,
      standing.reachedAt,
      standing.finishedAt,
    );
    return { ok: true };
  }

  /**
   * ゲーム状態から見た順位（`GET /api/teams/:code/game/leaderboard`）。ゴール（Finalへ
   * 入った時刻）の早い順、次に停留所の先の順、同じ停留所の中はそこへ動いたクリアの早い順
   * （Issue #159: 最後の操作の時刻では並べない）。チームコードは返さず、自分の行にだけ
   * isSelfを立てる。規則に合わないチームは既存の配信と同じく外す。
   */
  async gameStandings(teamCodeInput: unknown): Promise<GameStandingsSnapshot> {
    const teamCode = teamCodeSchema.parse(teamCodeInput);
    const rule = parseTeamCodeRule(this.env);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT team_code, stage, pos, reached_at, finished_at FROM game_standings
         ORDER BY finished_at IS NULL, finished_at, pos DESC, reached_at, team_code`,
      )
      .toArray()
      .map((row) => storedStandingSchema.safeParse(row).data)
      .filter((row) => row !== undefined)
      .filter((row) => isTeamCodeAllowed(row.team_code, rule));
    return {
      entries: rows.map((row, index) => ({
        marker: `チーム${String(index + 1)}`,
        isSelf: row.team_code === teamCode,
        stage: row.stage,
        pos: row.pos,
        reachedAt: row.reached_at,
        finishedAt: row.finished_at,
      })),
    };
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
          "SELECT team_revision, generation FROM leaderboard_entries WHERE team_code = ?",
          teamCode,
        )
        .toArray()
        .map((row) => storedEntryStateSchema.safeParse(row).data)
        .filter((row) => row !== undefined)[0] ?? null;
    if (supersededByExisting(existing, generation, snapshot.revision))
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
    // 重なった2つのリセットのうち、古い方が後から届いた。フェンスはMAXで単調なので
    // 下がらないが、行の削除と配信は無条件だった——新しいリセットのあとに入り直して
    // 帯に載ったチームが、遅れて届いた古いリセットで消えてしまう。何もせずに戻る。
    if (generation < this.fenceFor(teamCode)) return { ok: true };
    this.ctx.storage.transactionSync(() => {
      // 消すのは古い世代の行だけ。リーダーボードのリセットが届くより先に、入り直した
      // チームが新しい世代で載っていることがある——それまで消すと、次の遷移まで
      // そのチームが帯から消える。
      this.ctx.storage.sql.exec(
        "DELETE FROM leaderboard_entries WHERE team_code = ? AND generation < ?",
        teamCode,
        generation,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM game_standings WHERE team_code = ? AND generation < ?",
        teamCode,
        generation,
      );
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
