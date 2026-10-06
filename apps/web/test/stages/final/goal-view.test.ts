import { describe, expect, it } from "vitest";

import * as goal from "../../../src/stages/final/goal-view.js";
import * as view from "../../../src/stages/final/final-view.js";

describe("紙吹雪の片", () => {
  const pieces = goal.confettiPieces();

  it("64片を5色で順に塗り、毎回同じ片を出す", () => {
    expect(pieces).toHaveLength(64);
    expect(pieces.slice(0, 6).map((p) => p.color)).toEqual([
      ...goal.CONFETTI_COLORS,
      goal.CONFETTI_COLORS[0],
    ]);
    expect(goal.confettiPieces()).toEqual(pieces);
  });

  it("位置・遅延・落下時間・回転・横流れはモックの幅に収まり、3.4秒までに落ち切る", () => {
    for (const p of pieces) {
      expect(p.leftPct).toBeGreaterThanOrEqual(0);
      expect(p.leftPct).toBeLessThan(100);
      expect(p.delayMs).toBeGreaterThanOrEqual(0);
      expect(p.delayMs).toBeLessThan(300);
      expect(p.durationMs).toBeGreaterThanOrEqual(1800);
      expect(p.durationMs).toBeLessThan(3000);
      expect(p.rotDeg).toBeGreaterThanOrEqual(180);
      expect(p.rotDeg).toBeLessThan(720);
      expect(Math.abs(p.driftPx)).toBeLessThanOrEqual(60);
      expect(p.delayMs + p.durationMs).toBeLessThan(goal.CONFETTI_CLEAR_MS);
    }
  });

  it("片は画面の幅に散らばり、左右どちらにも流れる", () => {
    const tenths = new Set(pieces.map((p) => Math.floor(p.leftPct / 10)));
    expect(tenths.size).toBe(10);
    expect(pieces.some((p) => p.driftPx < 0)).toBe(true);
    expect(pieces.some((p) => p.driftPx > 0)).toBe(true);
    expect(new Set(pieces.map((p) => p.durationMs)).size).toBe(pieces.length);
  });

  it("0片を頼めば空", () => {
    expect(goal.confettiPieces(0)).toEqual([]);
  });
});

describe("ゴールの見出し", () => {
  it("名前はチーム名の前後の空白を落とし、空白だけなら既定の名", () => {
    expect(view.goalTeamName(" F班 ")).toBe("F班");
    expect(view.goalTeamName("　")).toBe("自チーム");
  });
});
