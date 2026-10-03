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

describe("停留所の帯", () => {
  it("Prologue から Final までの8停留所で、ゴールのマーカーは Final に立つ", () => {
    expect(goal.GOAL_STOPS).toEqual(["Prologue", "S1", "S2", "S3", "S4", "S5", "S6", "Final"]);
    expect(goal.GOAL_STOPS[goal.GOAL_STOP]).toBe("Final");
  });

  it("両端のマーカーは内側へ寄せ、途中は停留所の真上に中心を合わせる", () => {
    expect(goal.stopMark(0)).toEqual({ leftPct: 0, align: "start" });
    expect(goal.stopMark(1)).toEqual({ leftPct: 100 / 7, align: "center" });
    expect(goal.stopMark(6)).toEqual({ leftPct: 600 / 7, align: "center" });
    expect(goal.stopMark(7)).toEqual({ leftPct: 100, align: "end" });
  });

  it("マーカーの名前はチーム名で、空白だけなら既定の名", () => {
    expect(view.goalTeamName(" F班 ")).toBe("F班");
    expect(view.goalTeamName("　")).toBe("自チーム");
  });
});
