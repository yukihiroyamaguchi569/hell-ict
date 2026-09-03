import { detectPii } from "@hell-ict/domain";
import { z } from "zod";

import { error, json, parseJson } from "./http.js";
import type { RequestScope } from "./http.js";

/**
 * 研修1回分の活動ログ。チームごとのAIとのやり取り・提出物・判定結果を
 * 「発言単位で1行ずつ」D1へ積み、開催後にSQLで分析する
 * （手順は docs/testplay/ログ分析手順.md）。
 *
 * 前作「地獄のAI」Event 91の分析（前作リポジトリ Hell-AI-v2 の
 * docs/イベント分析/2026-08-28_Event91ログ分析.md）で、
 * messages.created_atが保存時に一括で書かれており発言単位の時刻が取れなかった。
 * その反省から、ここでは発言が起きた瞬間に1行ずつINSERTし、created_atは
 * ミリ秒精度で残す（会話の間合いやステージ滞留時間を後から復元できるようにする）。
 *
 * 進捗記録（progress.ts）と同じくゲーム進行からは独立しており、
 * 記録が落ちてもゲームは進む、という前提で全体を組む。
 */

/**
 * schema/activity.sqlと同じ内容。D1の`exec`は改行で文を区切るため、1文＝1行で書く。
 *
 * UNIQUEは、同じcommandIdの再送で行が二重に積まれるのをINSERT OR IGNOREで
 * 吸収するためのもの。1つのcommandIdからuser行とassistant行の2行が出るので
 * kindと複合にし、さらにevent_idとteam_codeまで含める——commandIdはクライアントが
 * 採番するため、別チームや別開催回で衝突しうる。狭いキーだと後から来た本物の
 * イベントが黙って捨てられる。command_idを持たないイベントを将来足したときに
 * 空文字どうしが衝突して静かに捨てられないよう、部分インデックスにしておく。
 */
export const activitySchemaSql = [
  "CREATE TABLE IF NOT EXISTS activity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL DEFAULT '', team_code TEXT NOT NULL, kind TEXT NOT NULL, view TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '', command_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', client_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));",
  "CREATE INDEX IF NOT EXISTS idx_activity_team ON activity_events(team_code, id);",
  "CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity_events(kind);",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_command ON activity_events(event_id, team_code, command_id, kind) WHERE command_id <> '';",
].join("\n");

/** ensureActivitySchemaが必要とするのはexecだけ。テストからFakeを渡せるよう最小限へ絞る。 */
export type SchemaRunner = Pick<D1Database, "exec">;

/**
 * progress.tsのensureSchemaと同じ流儀。初回アクセス時にテーブルを作り、
 * 実行中はPromiseそのものを覚えて後続を待たせる（真偽値フラグだと、コールドスタート
 * 直後に重なったリクエストがDDLの完了を待たずINSERTして落ちる）。
 * 失敗したらnullへ戻し、次のリクエストで作り直しを試みる。
 */
let schemaReady: Promise<void> | null = null;
export const ensureActivitySchema = (db: SchemaRunner): Promise<void> => {
  if (schemaReady !== null) return schemaReady;
  schemaReady = db.exec(activitySchemaSql).then(
    () => undefined,
    (caught: unknown) => {
      schemaReady = null;
      throw caught;
    },
  );
  return schemaReady;
};

/** 1行分の活動ログ。teamCodeとkind以外は「無ければ空文字」で埋める。 */
export type ActivityEvent = {
  readonly teamCode: string;
  readonly kind: string;
  readonly view?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly commandId?: string;
  readonly role?: string;
  readonly text?: string;
  readonly meta?: Record<string, unknown>;
  readonly clientAt?: string;
};

const INSERT_SQL = `INSERT OR IGNORE INTO activity_events
  (event_id, team_code, kind, view, thread_id, message_id, command_id, role, text, meta, client_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 省略された列は空文字で埋める。列ごとに`??`を並べると複雑度上限に触れるため関数へ寄せる。 */
const orEmpty = (value: string | undefined): string => value ?? "";

/**
 * 保存直前のPIIゲート。textだけでなくmetaも検査する——metaはクライアントが任意の
 * JSONを送れるうえ、サーバが作るmetaにも利用者入力（スレッドのtitle）が混ざるため、
 * textだけ見ていてはD1へPIIを残さない保証が破れる。
 *
 * metaは一致したキーだけ削るのではなく、丸ごと`{ piiRedacted: true }`へ置き換える。
 * PIIがどのキーに入るか事前に決められない以上、全部捨てる方が単純で漏れがない。
 * metaは分析の補助情報であり、失っても「いつ何が起きたか」の時系列は残る。
 *
 * textとmetaは独立に判定する。metaにPIIが混ざったことを理由にtextまで捨てると、
 * 較正の主材料である本文を不必要に失うため。
 */
const redactPii = (event: ActivityEvent): ActivityEvent => {
  const textHit = detectPii(orEmpty(event.text)) !== null;
  const metaHit = detectPii(JSON.stringify(event.meta ?? {})) !== null;
  if (!textHit && !metaHit) return event;
  return {
    ...event,
    text: textHit ? "" : event.text,
    meta: metaHit ? { piiRedacted: true } : { ...event.meta, piiRedacted: true },
  };
};

/**
 * 全ての書き込みがここを通る。redactPiiをこの一点へ置くことで、呼び出し側が
 * ゲートを掛け忘れてもPIIがD1へ残らない。
 */
const insertActivity = async (env: Env, input: ActivityEvent): Promise<void> => {
  const event = redactPii(input);
  await ensureActivitySchema(env.PROGRESS_DB);
  await env.PROGRESS_DB.prepare(INSERT_SQL)
    .bind(
      orEmpty(env.EVENT_ID),
      event.teamCode,
      event.kind,
      orEmpty(event.view),
      orEmpty(event.threadId),
      orEmpty(event.messageId),
      orEmpty(event.commandId),
      orEmpty(event.role),
      orEmpty(event.text),
      JSON.stringify(event.meta ?? {}),
      orEmpty(event.clientAt),
    )
    .run();
};

/**
 * サーバ側の自動記録。記録はゲーム進行より優先度が低いので、応答を待たせず
 * `waitUntil`へ逃がし、失敗しても握り潰す（ログのためにチャットが落ちる方が害が大きい）。
 */
export const logActivity = (scope: RequestScope, event: ActivityEvent): void => {
  scope.ctx.waitUntil(insertActivity(scope.env, event).catch(() => undefined));
};

/**
 * クライアント側から記録するイベント種別。提出物と判定結果、罠の発動、復帰を拾う。
 * サーバが自動で書く`chat.*`・`thread.*`はここには含めない。
 */
const activityKindSchema = z.enum([
  "submit.s1-reply",
  "verdict.s1",
  "submit.s2-grid",
  "verdict.s2",
  "submit.s3",
  "verdict.s3",
  "trap.s3",
  "submit.s35",
  "verdict.s35",
  "submit.s4",
  "verdict.s4",
  "trap.s4",
  "submit.s5-prompt",
  "select.s5",
  "submit.final",
  "resume",
]);

/** metaは自由なJSONだが、1行が肥大して分析クエリが重くなるのを粗い上限で止める。 */
const META_LIMIT_BYTES = 4096;

const clientActivitySchema = z.object({
  commandId: z.uuid(),
  kind: activityKindSchema,
  view: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
  text: z.string().max(20000).optional(),
  meta: z
    .record(z.string(), z.unknown())
    .refine((meta) => JSON.stringify(meta).length <= META_LIMIT_BYTES)
    .optional(),
  // 任意文字列にすると、textとmetaのPIIゲートを通らない自由記述の列が1つ残る
  // （実際に電話番号がそのまま保存できてしまう）。書式を固定して抜け道を塞ぐ。
  // クライアントは`new Date().toISOString()`を送るので、これで足りる。
  clientAt: z.iso.datetime(),
});

export const handleActivityPost = async (
  request: Request,
  env: Env,
  teamCode: string,
): Promise<Response> => {
  const parsed = await parseJson(request)
    .then((body) => clientActivitySchema.safeParse(body))
    .catch(() => null);
  if (parsed === null || !parsed.success) return error("活動ログの形式が不正です。", 400);

  try {
    await insertActivity(env, { ...parsed.data, teamCode });
    return json({ ok: true });
  } catch {
    return error("活動ログの記録に失敗しました。", 503);
  }
};
