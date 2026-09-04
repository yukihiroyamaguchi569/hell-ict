import { z } from "zod";

import {
  PII_REDACTION,
  publicTeamId,
  redactPii,
  teamCodeSchema,
  viewIdSchema,
} from "@hell-ict/domain";

import { isTeamCodeAllowed, parseTeamCodes } from "./guard.js";
import type { TeamCodeAllowlist } from "./guard.js";
import { bodyErrorResponse, error, json, parseJson } from "./http.js";

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
 * テーブルを作る。毎リクエストでDDLを流さないようモジュールスコープで1回に抑える。
 *
 * 「実行中」を真偽値ではなくPromiseそのもので覚える。コールドスタート直後に複数の
 * リクエストが重なると、真偽値では2本目が初期化の完了を待たずに先へ進み、まだ
 * テーブルが無い状態でINSERTして503になる。全員が同じPromiseをawaitすれば、
 * DDLは1回だけ流れ、後続は完了を待ってから進む。
 *
 * 失敗したときはnullへ戻し、次のリクエストで作り直しを試みる（1度の失敗で以後ずっと
 * テーブル無しのまま動き続ける状態を作らない）。
 */
/** ensureSchemaが必要とするのはexecだけ。テストからFakeを渡せるよう最小限へ絞る。 */
export type SchemaRunner = Pick<D1Database, "exec">;

let schemaReady: Promise<void> | null = null;
export const ensureSchema = (db: SchemaRunner): Promise<void> => {
  if (schemaReady !== null) return schemaReady;
  schemaReady = db.exec(progressSchemaSql).then(
    () => undefined,
    (caught: unknown) => {
      schemaReady = null;
      throw caught;
    },
  );
  return schemaReady;
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

/**
 * 意味を持つ値は切り詰めずに拒否する。posの範囲は8停留所（Prologue..Final）に対応する。
 * kindは、entry=停留所に入った、clear=突破した、jump=devbarやURLハッシュでの手動復帰、
 * resume=チェックポイントからの自動復帰。
 */
const progressEventSchema = z.object({
  teamCode: z.string().regex(/^\d{6}$/),
  teamName: displayText(24),
  pos: z.number().int().min(0).max(7),
  // 既知の画面idだけを受ける（checkpoint・活動ログと同じenum）。
  view: viewIdSchema,
  kind: z.enum(["entry", "clear", "jump", "resume"]),
  // 活動ログと同じくISO 8601で厳密に検証する。自由文字列のままだと、表示用の列に
  // 何でも入れられる経路が1つ残る（モックはtoISOString()を送るので互換性は保たれる）。
  clientAt: z.iso.datetime(),
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
 * - pos: 復帰イベント（jump=手動復帰、resume=チェックポイントからの自動復帰）は
 *   自力で進んだわけではないので集計から外す。復帰以外のイベントが1件も無いチームは
 *   0（Prologue）として扱う。
 * - teamName: 空文字で送られてくることがあるため、最新の「非空」の名前を採る。
 * - updatedAt: 生存確認なので復帰を含む全イベントの最新時刻を使う。
 */
/**
 * 許可リストの絞り込みはSQLへ入れる。取得後に落とすと、eventsのLIMIT 20を
 * 未登録チームの行が食い潰し、許可チームの最新イベントがダッシュボードから
 * 消える——「絞ってからLIMIT」でなければ意味がない。
 *
 * 未設定（null）なら条件を付けず全件を返す。プレースホルダは許可コードの数だけ
 * 動的に組む（当日の配布数は多くても数十）。
 */
const teamFilter = (
  allowlist: TeamCodeAllowlist,
  column: string,
): { clause: string; params: string[] } => {
  if (allowlist.kind === "unset") return { clause: "", params: [] };
  const codes = allowlist.kind === "list" ? [...allowlist.codes] : [];
  // 空の許可リスト（設定し損ね）と不正な設定はfail-closed。IN ()は書けないので
  // 常に偽の条件を置く。
  if (codes.length === 0) return { clause: `WHERE 0`, params: [] };
  return { clause: `WHERE ${column} IN (${codes.map(() => "?").join(", ")})`, params: codes };
};

const teamsSql = (filter: string): string => `SELECT
  e.team_code AS teamCode,
  COALESCE((
    SELECT i.team_name FROM progress_events i
    WHERE i.team_code = e.team_code AND i.team_name <> ''
    ORDER BY i.id DESC LIMIT 1
  ), '') AS teamName,
  COALESCE(MAX(CASE WHEN e.kind NOT IN ('jump', 'resume') THEN e.pos END), 0) AS pos,
  MAX(e.created_at) AS updatedAt
FROM progress_events e
${filter}
GROUP BY e.team_code
ORDER BY pos DESC, updatedAt ASC`;

const eventsSql = (filter: string): string => `SELECT
  team_code AS teamCode,
  team_name AS teamName,
  pos,
  view,
  kind,
  created_at AS createdAt
FROM progress_events
${filter}
ORDER BY id DESC
LIMIT 20`;

export const handleProgressPost = async (request: Request, env: Env): Promise<Response> => {
  // 本文の読み取り失敗（大きすぎる／壊れている）と、schema違反を区別して返す。
  const read = await parseJson(request).then(
    (body) => ({ ok: true as const, body }),
    (caught: unknown) => ({ ok: false as const, caught }),
  );
  if (!read.ok) return bodyErrorResponse(read.caught, "進捗イベントの形式が不正です。");
  const parsed = progressEventSchema.safeParse(read.body);
  if (!parsed.success) return error("進捗イベントの形式が不正です。", 400);

  const event = parsed.data;
  // チームコードは本文にあるため入口ガードでは見られない。D1へ書く前にここで当てる
  // （未登録チームの行をダッシュボードへ混ぜない）。応答は存在を明かさない404に揃える。
  if (!isTeamCodeAllowed(event.teamCode, parseTeamCodes(env.TEAM_CODES))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    await ensureSchema(env.PROGRESS_DB);
    await env.PROGRESS_DB.prepare(
      `INSERT INTO progress_events (team_code, team_name, pos, view, kind, client_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        event.teamCode,
        // teamNameは参加者が自由に入れられる表示用の値で、D1にも公開サマリーにも
        // そのまま出る。PIIと配布コードを伏せ字化してから保存する——拒否にしないのは、
        // 進捗記録が落ちるとダッシュボードからそのチームが消えて当日の進行が
        // 見えなくなるため。記録は残し、危ないものだけを落とす。
        // viewはschemaで既知の画面idに固定済みなので、そのまま入れてよい。
        redactDisplayText(event.teamName, parseTeamCodes(env.TEAM_CODES)),
        event.pos,
        event.view,
        event.kind,
        event.clientAt,
      )
      .run();
    return json({ ok: true });
  } catch {
    return error("進捗の記録に失敗しました。", 503);
  }
};

/**
 * 会場前面のダッシュボードが読む集計。POST側でも許可リストを当てているが、当日の
 * 設定が途中で入った場合や、設定前に積まれた行が残っている場合に、知らないチームが
 * 並ぶのを防ぐため、読み出し側でも絞る。
 */
/** 6桁の連続数字。配布コードが分からないときは、これを配布コードとみなして伏せる。 */
const SIX_DIGITS = /(?<!\d)\d{6}(?!\d)/g;

/**
 * 表示用テキストの伏せ字化。PIIに加えて配布チームコードも落とす——teamNameへ自分の
 * コードを入れられると、公開サマリー経由で他チームの端末へそのまま渡り、publicIdで
 * 隠した意味が無くなる（コードが唯一の入室資格）。
 *
 * 許可リストがあるときは、そこに載っているコードだけを伏せる（無関係な6桁の数字を
 * むやみに潰さない）。未設定・不正・空のときは配布コードが分からないので、6桁の連続
 * 数字を一律で伏せる。
 *
 * 保存時と読み出し時の両方で通す。読み出し側にも掛けるのは、この伏せ字化を入れる前に
 * 積まれた行が既にD1へ残っているため——保存時だけでは過去の行が公開され続ける。
 */
const redactDisplayText = (text: string, allowlist: TeamCodeAllowlist): string => {
  const withoutPii = redactPii(text);
  const known = allowlist.kind === "list" && allowlist.codes.size > 0 ? allowlist.codes : null;
  return known === null
    ? withoutPii.replace(SIX_DIGITS, PII_REDACTION)
    : withoutPii.replace(SIX_DIGITS, (code) => (known.has(code) ? PII_REDACTION : code));
};

type PublicRowContext = { selfCode: string | null; allowlist: TeamCodeAllowlist };

/**
 * 行のteamCodeを公開用IDへ差し替え、表示用テキストを伏せ字化する。生のチームコードは
 * 返さない——サマリーは参加者の端末からも読めるので、他チームのコードが見えると
 * そのまま入室に使えてしまう。自分の行だけ`isSelf`で見分けられるようにする。
 */
const toPublicRow = async <Row extends { teamCode: string; teamName: string }>(
  row: Row,
  context: PublicRowContext,
): Promise<Omit<Row, "teamCode"> & { publicId: string; isSelf?: true }> => {
  const { teamCode, ...rest } = row;
  const publicId = await publicTeamId(teamCode);
  const base = { ...rest, teamName: redactDisplayText(row.teamName, context.allowlist) };
  return context.selfCode !== null && teamCode === context.selfCode
    ? { ...base, publicId, isSelf: true }
    : { ...base, publicId };
};

/** eventsはviewも表示用テキストなので同じ伏せ字化を通す（enum化より前の行のため）。 */
const toPublicEventRow = async (
  row: z.infer<typeof eventRowSchema>,
  context: PublicRowContext,
): Promise<Omit<z.infer<typeof eventRowSchema>, "teamCode"> & { publicId: string }> => {
  const publicRow = await toPublicRow(row, context);
  return { ...publicRow, view: redactDisplayText(row.view, context.allowlist) };
};

/**
 * `?teamCode=`で自分の行を指定できる。許可リストを通らないコードは無視する
 * （未登録のコードで他チームの行へisSelfを立てさせない）。
 */
const selfTeamCode = (url: URL, allowlist: TeamCodeAllowlist): string | null => {
  const parsed = teamCodeSchema.safeParse(url.searchParams.get("teamCode"));
  if (!parsed.success) return null;
  return isTeamCodeAllowed(parsed.data, allowlist) ? parsed.data : null;
};

export const handleProgressSummary = async (env: Env, url: URL): Promise<Response> => {
  try {
    await ensureSchema(env.PROGRESS_DB);
    const allowlist = parseTeamCodes(env.TEAM_CODES);
    const selfCode = selfTeamCode(url, allowlist);
    const teamsFilter = teamFilter(allowlist, "e.team_code");
    const eventsFilter = teamFilter(allowlist, "team_code");
    const [teams, events] = await Promise.all([
      env.PROGRESS_DB.prepare(teamsSql(teamsFilter.clause))
        .bind(...teamsFilter.params)
        .all(),
      env.PROGRESS_DB.prepare(eventsSql(eventsFilter.clause))
        .bind(...eventsFilter.params)
        .all(),
    ]);
    const context: PublicRowContext = { selfCode, allowlist };
    return json({
      teams: await Promise.all(
        z
          .array(teamRowSchema)
          .parse(teams.results)
          .map((row) => toPublicRow(row, context)),
      ),
      events: await Promise.all(
        z
          .array(eventRowSchema)
          .parse(events.results)
          .map((row) => toPublicEventRow(row, context)),
      ),
    });
  } catch {
    return error("進捗の取得に失敗しました。", 503);
  }
};
