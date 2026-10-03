import { describe, expect, it } from "vitest";

import { auditWinners } from "../src/audit-winners.js";

/**
 * 監査賞の同着処理（Issue #343）。行は集計SQL（audit-award.sql）と同じ形・同じ並び
 * （所要の短い順）で渡す。SQLを通した結果はaggregation.test.tsが確かめる。
 */

/** Stage 3 に `startSec` 秒で入り、`durationMs` ミリ秒でクリアしたチームの行。 */
const row = (teamName: string, startSec: number, durationMs: number, s3Min = 0) => {
  const at = (ms: number): string =>
    new Date(Date.UTC(2026, 9, 31, 0, 0, 0, ms)).toISOString().replace("T", " ").replace("Z", "");
  return {
    team_name: teamName,
    s3_min: s3Min,
    s3_start: at(startSec * 1000),
    s3_clear: at(startSec * 1000 + durationMs),
  };
};

describe("auditWinners（監査賞の同着処理）", () => {
  it("該当なし: 行が無ければ空を返す", () => {
    expect(auditWinners([])).toEqual([]);
  });

  it("1チームだけなら、そのチームが受賞する", () => {
    const only = row("一班", 0, 60_000, 1);
    expect(auditWinners([only])).toEqual([only]);
  });

  it("所要が最短のチームだけを返す（2位以下は出ない）", () => {
    const rows = [row("五班", 0, 24_000), row("二班", 0, 30_000), row("一班", 0, 60_000)];
    expect(auditWinners(rows)).toEqual([rows[0]]);
  });

  it("同着2チーム: 所要がミリ秒まで同じなら、入った時刻が違っても両方を並びのまま返す", () => {
    const rows = [row("三班", 10, 24_000), row("七班", 95, 24_000), row("二班", 0, 30_000)];
    expect(auditWinners(rows)).toEqual([rows[0], rows[1]]);
  });

  it("同着3チーム以上もすべて返す", () => {
    const rows = [
      row("一班", 0, 24_000),
      row("二班", 5, 24_000),
      row("三班", 7, 24_000),
      row("四班", 0, 24_001),
    ];
    expect(auditWinners(rows)).toEqual(rows.slice(0, 3));
  });

  it("境界: 1ミリ秒でも長ければ同着にしない", () => {
    const rows = [row("一班", 0, 24_000), row("二班", 0, 24_001)];
    expect(auditWinners(rows)).toEqual([rows[0]]);
  });

  it("表示用のs3_minが同じでも、ミリ秒の所要が違えば同着にしない", () => {
    // どちらも0.4分に丸まるが、所要は24.000秒と24.500秒。
    const rows = [row("一班", 0, 24_000, 0.4), row("二班", 0, 24_500, 0.4)];
    expect(auditWinners(rows)).toEqual([rows[0]]);
  });

  it("行の中身（team_nameやs3_min）はそのまま返し、渡した配列は変えない", () => {
    const rows = [row("一班", 0, 24_000, 0.4), row("二班", 3, 24_000, 0.4)];
    const before = structuredClone(rows);
    const winners = auditWinners(rows);
    expect(winners[0]).toBe(rows[0]);
    expect(winners[1]).toBe(rows[1]);
    expect(rows).toEqual(before);
  });
});
