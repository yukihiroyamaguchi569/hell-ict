import { z } from "zod";

import auditAwardSql from "../aggregation/audit-award.sql";
import handoverSql from "../aggregation/handover.sql";
import winnerSql from "../aggregation/winner.sql";
import { ensureActivitySchema } from "./activity-log.js";
import { auditWinners } from "./audit-winners.js";
import { isGmAuthorized } from "./gm.js";
import { parseEventNo } from "./guard.js";
import { error, json } from "./http.js";
import { ensureSchema } from "./progress.js";

/**
 * デブリーフィングの集計（GM専用の読み取り）。会場前面へ映す番付の画面
 * （apps/worker/dashboard/ranking.html → /ranking.html）が、開いたときに1回だけ叩く。
 * - `GET /api/gm/debrief/results`: 着順と監査賞の受賞チーム
 * - `GET /api/gm/debrief/handover`: 次のICTへの申し送り（Finalの一言）
 *
 * SQLの正本は apps/worker/aggregation/*.sql で、wranglerのText module（`.sql`の既定の
 * 取り込み規則）としてそのままバンドルする。手元の予備（scripts/ranking-board）と、
 * wranglerで手で流す手順（docs/development-harness.md）も同じファイルを読む。
 *
 * 開催回はWorkerのEVENT_NOで埋める（置き換え忘れで別の回を映さない）。EVENT_NOは
 * parseEventNoで2桁数字に限ってからSQLへ入れる。
 *
 * 監査賞の結果は参加者に先に見られるとネタバレになるので、GMのリセットと同じ
 * ADMIN_TOKENで守り、通らなければGM系と同じ404を返す（gm.ts先頭の注記）。
 * チームコードは返さない（見えた時点でそのチームへ入室できてしまう）。
 */

const notFound = (): Response => new Response("Not found", { status: 404 });

const winnerRowSchema = z.object({ team_name: z.string(), goal_at_utc: z.string() });
const auditRowSchema = z.object({
  team_name: z.string(),
  s3_min: z.number(),
  s3_start: z.string(),
  s3_clear: z.string(),
});
const handoverRowSchema = z.object({ team_name: z.string(), text: z.string() });

export const debriefResultsSchema = z
  .object({
    eventNo: z.string(),
    fetchedAt: z.string(),
    goals: z.array(z.object({ teamName: z.string(), goalAtUtc: z.string() }).strict()),
    audit: z.array(z.object({ teamName: z.string(), s3Min: z.number() }).strict()),
  })
  .strict();

export const debriefHandoverSchema = z
  .object({
    eventNo: z.string(),
    fetchedAt: z.string(),
    // textが空なら、PIIゲートで本文ごと保存されなかった一言。
    handovers: z.array(z.object({ teamName: z.string(), text: z.string() }).strict()),
  })
  .strict();

const runAggregation = async <T>(
  db: D1Database,
  sql: string,
  eventNo: string,
  rowSchema: z.ZodType<T>,
): Promise<T[]> => {
  const { results } = await db.prepare(sql.replaceAll("{{EVENT_NO}}", eventNo)).all();
  return z.array(rowSchema).parse(results);
};

const results = async (db: D1Database, eventNo: string) => {
  const goals = await runAggregation(db, winnerSql, eventNo, winnerRowSchema);
  const audit = await runAggregation(db, auditAwardSql, eventNo, auditRowSchema);
  return debriefResultsSchema.parse({
    eventNo,
    fetchedAt: new Date().toISOString(),
    goals: goals.map((row) => ({ teamName: row.team_name, goalAtUtc: row.goal_at_utc })),
    audit: auditWinners(audit).map((row) => ({ teamName: row.team_name, s3Min: row.s3_min })),
  });
};

const handover = async (db: D1Database, eventNo: string) => {
  const rows = await runAggregation(db, handoverSql, eventNo, handoverRowSchema);
  return debriefHandoverSchema.parse({
    eventNo,
    fetchedAt: new Date().toISOString(),
    handovers: rows.map((row) => ({ teamName: row.team_name, text: row.text })),
  });
};

const DEBRIEF_ROUTES: Readonly<
  Record<string, (db: D1Database, eventNo: string) => Promise<unknown>>
> = {
  "/api/gm/debrief/results": results,
  "/api/gm/debrief/handover": handover,
};

/** トークン→経路→開催回→集計の順に判定する。応答のヘッダーはhandleGmGetが足す。 */
const respondGmGet = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (!(await isGmAuthorized(request, env))) return notFound();
  const route = DEBRIEF_ROUTES[url.pathname];
  if (route === undefined) return notFound();
  const eventNo = parseEventNo(env.EVENT_NO);
  if (eventNo === null) {
    return error(
      "EVENT_NO（開催回の2桁）が設定されていないため集計できません。`wrangler secret put EVENT_NO`で設定してください。",
      500,
    );
  }
  try {
    await ensureSchema(env.PROGRESS_DB);
    await ensureActivitySchema(env.PROGRESS_DB);
    return json(await route(env.PROGRESS_DB, eventNo));
  } catch {
    return error("集計に失敗しました。時間を置いて再読み込みしてください。", 503);
  }
};

/**
 * `/api/gm/`配下のGETをすべて受ける。トークンを最初に見るので、未知のパスも404に揃う。
 * 成功もエラーも`Cache-Control: no-store`にする——画面のfetchの指定は、ほかの経路
 * （直接開いたブラウザや途中のキャッシュ）には効かず、集計や拒否が古いまま残りうる。
 */
export const handleGmGet = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const response = await respondGmGet(request, env, url);
  response.headers.set("Cache-Control", "no-store");
  return response;
};
