import { z } from "zod";

import { RATE_LIMIT_WINDOW_MS, rateLimitBucket, rateLimitRetryAfterSeconds } from "./guard.js";

/**
 * TeamRoom's fixed-window rate limit over the rate_limit table. Plain functions over the
 * DO's SqlStorage: they stay synchronous so TeamRoom can call them inside transactionSync.
 */

/** レート制限の用途。同じテーブル・同じ固定窓を、接頭辞で分けて数える。 */
export type RateLimitKind = "chat" | "activity";

/** consumeChatAttempt / consumeActivityAttemptの判定。超過なら待つべき秒数を返す。 */
export type RateLimitVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/** rate_limitの行。壊れた値でレート制限が黙って無効化されないよう実行時に検証する。 */
const storedRateLimitSchema = z.object({ count: z.number().int().nonnegative() });

/**
 * 現在の窓のカウンタを読む。行が無い、または値が壊れている（型が違う、負数）ときは0を返す。
 *
 * 自前で書いている行だが、SQLiteは列の型を強制しないので、手作業のSQLや将来の
 * スキーマ変更で数値以外が入りうる。素通しするとNaNとの比較が常にfalseになり、
 * レート制限が例外もログも出さずに効かなくなる。壊れた行は0として扱い、
 * consumeRateLimitの上書きで正しい値へ戻す。
 */
const rateLimitCount = (sql: SqlStorage, bucket: string): number => {
  const row =
    sql.exec("SELECT count FROM rate_limit WHERE bucket = ?", bucket).toArray()[0] ?? null;
  if (row === null) return 0;
  return storedRateLimitSchema.safeParse(row).data?.count ?? 0;
};

/**
 * 固定窓の枠を1つ消費する。消費できたらnull、超過していたら待つべき秒数を返す。
 *
 * beginChatMessageの中からだけ呼ぶ。以前は別RPCとしてWorkerから先に呼んでいたが、
 * それだと「枠の予約」と「pending行の作成」が別々のDO操作になり、同じcommandIdの
 * 並行再送が二重に枠を減らした。1操作にまとめると、DOの直列実行がそのまま
 * 「数えるのは新しいpending行を作るときだけ」を保証する。
 *
 * `nowMs`はWorkerから渡す。DO内でDate.now()を直書きすると窓をテストから固定できない。
 */
export const consumeRateLimit = (
  sql: SqlStorage,
  kind: RateLimitKind,
  nowMs: number,
  limit: number,
): number | null => {
  // 用途ごとに接頭辞を付けて枠を分ける。チャットと活動ログを同じ枠で数えると、
  // ログが詰まってゲーム操作が止まる（あるいはその逆）ことになる。
  const bucket = `${kind}:${rateLimitBucket(nowMs, RATE_LIMIT_WINDOW_MS)}`;
  const count = rateLimitCount(sql, bucket);
  if (count >= limit) return rateLimitRetryAfterSeconds(nowMs, RATE_LIMIT_WINDOW_MS);
  // 固定窓なので過去の窓の行は不要。消費するときに掃除して用途ごとに1行だけ残す
  // （超過で戻るときは1行も書かないよう、判定より後に置く）。
  sql.exec("DELETE FROM rate_limit WHERE bucket <> ? AND bucket LIKE ?", bucket, `${kind}:%`);
  // `count + 1`ではなく読み取った値からの上書きにする。壊れた行へ加算し続けると
  // 上限へ永久に届かず、制限が黙って無効化される。
  sql.exec("INSERT OR REPLACE INTO rate_limit (bucket, count) VALUES (?, ?)", bucket, count + 1);
  return null;
};
