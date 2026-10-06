import { describe, expect, it } from "vitest";

import {
  VERDICT_TICK_DURATION_MS,
  VERDICT_TICK_VOLUME,
  verdictTickDelayMs,
  verdictTicks,
} from "../../src/verdict/verdict-ticks.js";

describe("verdictTickDelayMs", () => {
  it("1行目は200ms、以後400msおき（Stage 2 のクリアの行は1.8s）", () => {
    expect([0, 1, 2, 3, 4].map(verdictTickDelayMs)).toEqual([200, 600, 1_000, 1_400, 1_800]);
  });
});

describe("verdictTicks", () => {
  it("✓ の行ごとに1音、行が見え始める時刻に、音程を上げて鳴らす", () => {
    const ticks = verdictTicks(4);
    expect(ticks.map((tick) => tick.atMs)).toEqual([200, 600, 1_000, 1_400]);
    expect(ticks.map((tick) => tick.tone.frequencyHz)).toEqual([880, 988, 1109, 1319]);
    for (const tick of ticks) {
      expect(tick.tone).toMatchObject({
        durationMs: VERDICT_TICK_DURATION_MS,
        volume: VERDICT_TICK_VOLUME,
      });
    }
  });

  it("短く小さい音（60〜90ms、効果音の既定 0.4 より小さい）", () => {
    expect(VERDICT_TICK_DURATION_MS).toBeGreaterThanOrEqual(60);
    expect(VERDICT_TICK_DURATION_MS).toBeLessThanOrEqual(90);
    expect(VERDICT_TICK_VOLUME).toBeLessThan(0.4);
  });

  it("行が無ければ鳴らさない（0行・負の数）", () => {
    expect(verdictTicks(0)).toEqual([]);
    expect(verdictTicks(-1)).toEqual([]);
  });

  it("音程の数より行が多ければ、いちばん高い音で鳴らし続ける", () => {
    const ticks = verdictTicks(6);
    expect(ticks.map((tick) => tick.tone.frequencyHz)).toEqual([880, 988, 1109, 1319, 1319, 1319]);
    expect(ticks.at(-1)?.atMs).toBe(2_200);
  });
});
