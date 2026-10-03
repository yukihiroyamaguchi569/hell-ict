import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { RATE_LIMIT_WINDOW_MS, rateLimitBucket } from "../src/guard.js";
import { consumeRateLimit } from "../src/rate-limit-store.js";

// Start of a window, so every offset below stays inside the same window.
const windowStartMs = 1_756_000_020_000;
const nextWindowMs = windowStartMs + RATE_LIMIT_WINDOW_MS;

const bucketOf = (kind: string, nowMs: number): string =>
  `${kind}:${rateLimitBucket(nowMs, RATE_LIMIT_WINDOW_MS)}`;

type RateLimitRow = { bucket: string; count: unknown };

/** Runs `body` against a TeamRoom's real SqlStorage (the constructor creates rate_limit). */
const withSql = <T>(name: string, body: (sql: SqlStorage) => T): Promise<T> =>
  runInDurableObject(env.TEAM_ROOM.getByName(name), (_instance, state) => body(state.storage.sql));

const rowsOf = (sql: SqlStorage): RateLimitRow[] =>
  sql
    .exec("SELECT bucket, count FROM rate_limit ORDER BY bucket")
    .toArray()
    .map((row) => ({ bucket: String(row.bucket), count: row.count }));

describe("consumeRateLimit（固定窓の枠の消費）", () => {
  it("上限ちょうどまで通し、上限を超えた1回は待つ秒数を返して行を書き換えない", async () => {
    const result = await withSql("rate-limit-001", (sql) => {
      const verdicts = [1, 2, 3].map(() => consumeRateLimit(sql, "chat", windowStartMs, 3));
      const before = rowsOf(sql);
      const over = consumeRateLimit(sql, "chat", windowStartMs + 15_000, 3);
      return { verdicts, before, over, after: rowsOf(sql) };
    });

    expect(result.verdicts).toEqual([null, null, null]);
    expect(result.before).toEqual([{ bucket: bucketOf("chat", windowStartMs), count: 3 }]);
    // 15 s into a 60 s window: 45 s until it ends.
    expect(result.over).toBe(45);
    expect(result.after).toEqual(result.before);
  });

  it("窓の終わり際の超過でも、待つ秒数は最低1秒になる", async () => {
    const over = await withSql("rate-limit-002", (sql) => {
      consumeRateLimit(sql, "chat", windowStartMs, 1);
      return consumeRateLimit(sql, "chat", nextWindowMs - 1, 1);
    });

    expect(over).toBe(1);
  });

  it("窓が切り替わると数え直し、同じ用途の古い窓の行を消す", async () => {
    const result = await withSql("rate-limit-003", (sql) => {
      consumeRateLimit(sql, "chat", windowStartMs, 1);
      const blocked = consumeRateLimit(sql, "chat", nextWindowMs - 1, 1);
      const next = consumeRateLimit(sql, "chat", nextWindowMs, 1);
      return { blocked, next, rows: rowsOf(sql) };
    });

    expect(result.blocked).toBe(1);
    expect(result.next).toBeNull();
    expect(result.rows).toEqual([{ bucket: bucketOf("chat", nextWindowMs), count: 1 }]);
  });

  it("用途ごとに別の枠で数え、窓の切り替えでも他の用途の行は消さない", async () => {
    const result = await withSql("rate-limit-004", (sql) => {
      consumeRateLimit(sql, "activity", windowStartMs, 1);
      const chat = consumeRateLimit(sql, "chat", windowStartMs, 1);
      const nextChat = consumeRateLimit(sql, "chat", nextWindowMs, 1);
      return { chat, nextChat, rows: rowsOf(sql) };
    });

    expect(result.chat).toBeNull();
    expect(result.nextChat).toBeNull();
    expect(result.rows).toEqual([
      { bucket: bucketOf("activity", windowStartMs), count: 1 },
      { bucket: bucketOf("chat", nextWindowMs), count: 1 },
    ]);
  });

  it("壊れた行（型違い・負数）は0として数え、読み取った値からの上書きで直す", async () => {
    const result = await withSql("rate-limit-005", (sql) =>
      ["こわれた", -5].map((broken) => {
        sql.exec(
          "INSERT OR REPLACE INTO rate_limit (bucket, count) VALUES (?, ?)",
          bucketOf("chat", windowStartMs),
          broken,
        );
        const verdict = consumeRateLimit(sql, "chat", windowStartMs, 1);
        const blocked = consumeRateLimit(sql, "chat", windowStartMs, 1);
        return { verdict, blocked, rows: rowsOf(sql) };
      }),
    );

    for (const round of result) {
      expect(round.verdict).toBeNull();
      expect(round.blocked).toBe(60);
      expect(round.rows).toEqual([{ bucket: bucketOf("chat", windowStartMs), count: 1 }]);
    }
  });
});
