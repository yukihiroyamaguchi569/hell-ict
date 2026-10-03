import { describe, expect, it } from "vitest";

import { remainingMs } from "../../src/stages/deadline.js";
import { STAGE5_DEADLINE_MS, stage5DeadlineAt } from "../../src/stages/s5.js";

const ENTERED = "2026-10-31T02:00:00.000Z";
const ENTERED_MS = Date.parse(ENTERED);

describe("stage5DeadlineAt", () => {
  it("モックの S5_DEADLINE（120秒）と同じ", () => {
    expect(STAGE5_DEADLINE_MS).toBe(120_000);
  });

  it("Stage 5 に入った時刻のちょうど120秒後", () => {
    expect(stage5DeadlineAt(ENTERED)).toBe(ENTERED_MS + 120_000);
  });

  it.each([
    [-1, 1],
    [0, 0],
    [1, 0],
  ])("期限の %ims 後の残りは %ims（ちょうどで0、1ms 前はまだ残る）", (offset, left) => {
    expect(remainingMs(stage5DeadlineAt(ENTERED), ENTERED_MS + 120_000 + offset)).toBe(left);
  });

  it("ミリ秒つきの入場時刻もそのまま足す", () => {
    expect(stage5DeadlineAt("2026-10-31T02:00:00.999Z")).toBe(ENTERED_MS + 999 + 120_000);
  });

  it("時刻として読めない値は NaN（どの時刻とも比べて期限にならない）", () => {
    expect(stage5DeadlineAt("not-a-time")).toBeNaN();
  });
});
