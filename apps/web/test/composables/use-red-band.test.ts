import { stageEntryBands } from "@hell-ict/content";
import { gameInstantSchema } from "@hell-ict/domain";
import type { GameEvent } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import {
  BAND_FADE_MS,
  BAND_HOLD_MS,
  bandStageOf,
  useRedBand,
} from "../../src/composables/use-red-band.js";
import { FakeScheduler, START_MS } from "../fakes.js";

const AT = gameInstantSchema.parse(new Date(START_MS).toISOString());
const entered = (stage: "s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "final"): GameEvent => ({
  type: "stage-entered",
  stage,
  at: AT,
});
const cleared = (stage: "s1" | "s2"): GameEvent => ({ type: "stage-cleared", stage, at: AT });

const setup = () => {
  const scheduler = new FakeScheduler();
  const listeners = new Set<(events: readonly GameEvent[]) => void>();
  let alarms = 0;
  const scope = effectScope();
  const band = scope.run(() =>
    useRedBand({
      scheduler,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onShow: () => {
        alarms += 1;
      },
    }),
  );
  if (band === undefined) throw new Error("scope did not run");
  const emit = (events: readonly GameEvent[]): void => {
    for (const listener of listeners) listener(events);
  };
  return { scheduler, band, emit, scope, listeners, alarms: () => alarms };
};

describe("bandStageOf", () => {
  it("赤帯を持つステージへの入場だけを拾う", () => {
    expect(bandStageOf([])).toBeNull();
    expect(bandStageOf([cleared("s1")])).toBeNull();
    expect(bandStageOf([entered("s1")])).toBeNull();
    expect(bandStageOf([entered("s6")])).toBeNull();
    expect(bandStageOf([entered("final")])).toBeNull();
    for (const stage of ["s2", "s3", "s4", "s5"] as const) {
      expect(bandStageOf([cleared("s1"), entered(stage)])).toBe(stage);
    }
  });

  it("まとめて届いたら最後の入場", () => {
    expect(bandStageOf([entered("s2"), entered("s3")])).toBe("s3");
    expect(bandStageOf([entered("s3"), entered("s6")])).toBe("s3");
  });
});

describe("useRedBand", () => {
  it("初めは出ていない", () => {
    const { band } = setup();
    expect(band.phase.value).toBe("hidden");
  });

  it("Stage 2 の入場：滑り込み→ 3000ms 後に退場→ 400ms で消える。警報は1回", () => {
    const { band, emit, scheduler, alarms } = setup();
    emit([cleared("s1"), entered("s2")]);
    expect(band.phase.value).toBe("in");
    expect(band.text.value).toBe(stageEntryBands.s2);
    expect(alarms()).toBe(1);
    scheduler.advanceBy(BAND_HOLD_MS.s2 - 1);
    expect(band.phase.value).toBe("in");
    scheduler.advanceBy(1);
    expect(band.phase.value).toBe("out");
    scheduler.advanceBy(BAND_FADE_MS - 1);
    expect(band.phase.value).toBe("out");
    scheduler.advanceBy(1);
    expect(band.phase.value).toBe("hidden");
    expect(alarms()).toBe(1);
  });

  it("Stage 3〜5 は 2200ms 保持", () => {
    expect(BAND_HOLD_MS).toEqual({ s2: 3_000, s3: 2_200, s4: 2_200, s5: 2_200 });
    const { band, emit, scheduler } = setup();
    emit([entered("s4")]);
    expect(band.text.value).toBe(stageEntryBands.s4);
    scheduler.advanceBy(2_200);
    expect(band.phase.value).toBe("out");
  });

  it("赤帯の無い出来事では出さず、警報も鳴らさない", () => {
    const { band, emit, alarms, scheduler } = setup();
    emit([cleared("s1")]);
    emit([entered("s6")]);
    emit([]);
    expect(band.phase.value).toBe("hidden");
    expect(alarms()).toBe(0);
    expect(scheduler.pending).toBe(0);
  });

  it("出ている間に次の入場が来たら、次の帯で出し直す（前のタイマーは捨てる）", () => {
    const { band, emit, scheduler } = setup();
    emit([entered("s2")]);
    scheduler.advanceBy(2_000);
    emit([entered("s3")]);
    expect(band.text.value).toBe(stageEntryBands.s3);
    expect(scheduler.pending).toBe(1);
    scheduler.advanceBy(1_000);
    expect(band.phase.value).toBe("in");
    scheduler.advanceBy(1_200);
    expect(band.phase.value).toBe("out");
  });

  it("破棄したら購読とタイマーを止める", () => {
    const { emit, scope, listeners, scheduler, alarms } = setup();
    emit([entered("s2")]);
    scope.stop();
    expect(listeners.size).toBe(0);
    expect(scheduler.pending).toBe(0);
    emit([entered("s3")]);
    expect(alarms()).toBe(1);
  });
});
