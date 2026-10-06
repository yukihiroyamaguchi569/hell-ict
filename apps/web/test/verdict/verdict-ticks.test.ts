import { describe, expect, it } from "vitest";

import {
  VERDICT_CHECK_TONE,
  VERDICT_DONE_TONE,
  verdictTickDelayMs,
  verdictTicks,
} from "../../src/verdict/verdict-ticks.js";

describe("verdictTickDelayMs", () => {
  it("1行目は200ms、以後400msおき（Stage 2 のクリアの行は1.8s）", () => {
    expect([0, 1, 2, 3, 4].map(verdictTickDelayMs)).toEqual([200, 600, 1_000, 1_400, 1_800]);
  });
});

describe("verdictTicks", () => {
  it("✓ の4行は同じ 988Hz、クリアの行（1.8s）は 1760Hz。行が見え始める時刻に1回ずつ", () => {
    expect(verdictTicks(4).map((tick) => [tick.atMs, tick.tone.frequencyHz])).toEqual([
      [200, 988],
      [600, 988],
      [1_000, 988],
      [1_400, 988],
      [1_800, 1760],
    ]);
  });

  it("✓ の音は 70ms・0.12、クリアの音は 90ms・0.12（効果音の既定 0.4 より小さい）", () => {
    expect(VERDICT_CHECK_TONE).toEqual({ frequencyHz: 988, durationMs: 70, volume: 0.12 });
    expect(VERDICT_DONE_TONE).toEqual({ frequencyHz: 1760, durationMs: 90, volume: 0.12 });
  });

  it("✓ の行が無ければ、クリアの行の1音だけを最初の行の時刻に（0行・負の数）", () => {
    expect(verdictTicks(0)).toEqual([{ atMs: 200, tone: VERDICT_DONE_TONE }]);
    expect(verdictTicks(-1)).toEqual([{ atMs: 200, tone: VERDICT_DONE_TONE }]);
  });
});
