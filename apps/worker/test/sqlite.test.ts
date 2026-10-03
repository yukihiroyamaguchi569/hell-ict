import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { isDuplicateColumn } from "../src/sqlite.js";
import { session } from "./support.js";

describe("isDuplicateColumn", () => {
  it("『列が既にある』失敗だけを握り、ほかは握らない", () => {
    // 移行の2度目以降。ここだけを握って移行済みとみなす。
    expect(
      isDuplicateColumn(new Error("D1_ERROR: duplicate column name: generation: SQLITE_ERROR")),
    ).toBe(true);
    // 本物の失敗。握ると、列の無いまま初期化が成功扱いで固定される。
    expect(isDuplicateColumn(new Error("D1_ERROR: no such table: progress_events"))).toBe(false);
    expect(isDuplicateColumn(new Error("Network connection lost."))).toBe(false);
    // Errorですらない値を真と誤らない。
    expect(isDuplicateColumn("duplicate column name: generation")).toBe(false);
    expect(isDuplicateColumn(null)).toBe(false);
  });

  /**
   * 文言での判定なので、実際のストレージが返す失敗と突き合わせておく。ここがずれると、
   * 2度目の起動でRaceLeaderboardのコンストラクタが例外になり、帯が丸ごと止まる。
   */
  it("Durable Objectのストレージが返す重複列の失敗を見分けられる", async () => {
    await session("500090");
    const message = await runInDurableObject(
      env.RACE_LEADERBOARD.getByName("global"),
      (_instance, state) => {
        try {
          state.storage.sql.exec(
            "ALTER TABLE leaderboard_entries ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
          );
          return null;
        } catch (caught) {
          return caught instanceof Error ? caught.message : String(caught);
        }
      },
    );
    expect(message).not.toBeNull();
    expect(isDuplicateColumn(new Error(message ?? ""))).toBe(true);
  });
});
