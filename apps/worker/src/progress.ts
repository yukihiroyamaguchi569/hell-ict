import { z } from "zod";

import { error, json, parseJson } from "./http.js";

/**
 * テストプレイ当日の進捗記録。参加者のブラウザから位置イベントをD1へ積み、
 * 会場前面のダッシュボード（apps/worker/dashboard/index.html）が
 * GET /api/progress/summary をポーリングして表示する。
 *
 * 研修一回分の使い捨てデータであり、ゲーム進行そのもの（TeamRoom / RaceLeaderboard）
 * とは独立している。記録が落ちてもゲームは進む、という前提で全体を組む。
 */

/**
 * schema/progress.sqlと同じ内容。D1の`exec`は改行で文を区切るため、1文＝1行で書く
 * （複数文を1行へ詰めると実行時に弾かれる）。テストからも同じ定義を使い、
 * 本番とテストでスキーマがずれないようにする。
 */
export const progressSchemaSql = [
  "CREATE TABLE IF NOT EXISTS progress_events (id INTEGER PRIMARY KEY AUTOINCREMENT, team_code TEXT NOT NULL, team_name TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL, view TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, client_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));",
  "CREATE INDEX IF NOT EXISTS idx_progress_team ON progress_events(team_code, id);",
].join("\n");

/**
 * schema/progress.sqlの適用忘れで当日リクエストが全滅しないよう、初回アクセス時に
 * テーブルを作る。毎リクエストでDDLを流さないようモジュールスコープで1回に抑えるが、
 * 失敗したときはフラグを戻して次のリクエストで再試行する（1度の失敗で
 * 以後ずっとテーブル無しのまま動き続ける状態を作らない）。
 */
let schemaReady = false;
const ensureSchema = async (db: D1Database): Promise<void> => {
  if (schemaReady) return;
  schemaReady = true;
  try {
    await db.exec(progressSchemaSql);
  } catch (caught) {
    schemaReady = false;
    throw caught;
  }
};

/**
 * 表示専用の自由文字列。上限超過を400にすると、当日クライアントが1文字でも長い値を
 * 送った瞬間にそのチームだけダッシュボードから消える。仕様どおりの長さしか送らない
 * クライアントには影響しないので、暴走だけ粗い上限で止めて規定長へ切り詰める。
 */
const displayText = (limit: number): z.ZodType<string> =>
  z
    .string()
    .max(2000)
    .transform((value) => value.slice(0, limit));

/** 意味を持つ値は切り詰めずに拒否する。posの範囲は8停留所（Prologue..Final）に対応する。 */
const progressEventSchema = z.object({
  teamCode: z.string().regex(/^\d{6}$/),
  teamName: displayText(24),
  pos: z.number().int().min(0).max(7),
  view: displayText(32),
  kind: z.enum(["entry", "clear", "jump"]),
  clientAt: displayText(40),
});

const teamRowSchema = z.object({
  teamCode: z.string(),
  teamName: z.string(),
  pos: z.number().int(),
  updatedAt: z.string(),
});

const eventRowSchema = z.object({
  teamCode: z.string(),
  teamName: z.string(),
  pos: z.number().int(),
  view: z.string(),
  kind: z.string(),
  createdAt: z.string(),
});

/**
 * チームごとの現在位置。
 * - pos: kind='jump'（devbarやURLハッシュでの復帰）は進捗と見なさないので集計から外す。
 *   非jumpイベントが1件も無いチームは0（Prologue）として扱う。
 * - teamName: 空文字で送られてくることがあるため、最新の「非空」の名前を採る。
 * - updatedAt: 生存確認なのでjumpを含む全イベントの最新時刻を使う。
 */
const TEAMS_SQL = `SELECT
  e.team_code AS teamCode,
  COALESCE((
    SELECT i.team_name FROM progress_events i
    WHERE i.team_code = e.team_code AND i.team_name <> ''
    ORDER BY i.id DESC LIMIT 1
  ), '') AS teamName,
  COALESCE(MAX(CASE WHEN e.kind <> 'jump' THEN e.pos END), 0) AS pos,
  MAX(e.created_at) AS updatedAt
FROM progress_events e
GROUP BY e.team_code
ORDER BY pos DESC, updatedAt ASC`;

const EVENTS_SQL = `SELECT
  team_code AS teamCode,
  team_name AS teamName,
  pos,
  view,
  kind,
  created_at AS createdAt
FROM progress_events
ORDER BY id DESC
LIMIT 20`;

export const handleProgressPost = async (request: Request, env: Env): Promise<Response> => {
  const parsed = await parseJson(request)
    .then((body) => progressEventSchema.safeParse(body))
    .catch(() => null);
  if (parsed === null || !parsed.success) return error("進捗イベントの形式が不正です。", 400);

  const event = parsed.data;
  try {
    await ensureSchema(env.PROGRESS_DB);
    await env.PROGRESS_DB.prepare(
      `INSERT INTO progress_events (team_code, team_name, pos, view, kind, client_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(event.teamCode, event.teamName, event.pos, event.view, event.kind, event.clientAt)
      .run();
    return json({ ok: true });
  } catch {
    return error("進捗の記録に失敗しました。", 503);
  }
};

export const handleProgressSummary = async (env: Env): Promise<Response> => {
  try {
    await ensureSchema(env.PROGRESS_DB);
    const [teams, events] = await Promise.all([
      env.PROGRESS_DB.prepare(TEAMS_SQL).all(),
      env.PROGRESS_DB.prepare(EVENTS_SQL).all(),
    ]);
    return json({
      teams: z.array(teamRowSchema).parse(teams.results),
      events: z.array(eventRowSchema).parse(events.results),
    });
  } catch {
    return error("進捗の取得に失敗しました。", 503);
  }
};
