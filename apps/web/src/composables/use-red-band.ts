import { stageEntryBands } from "@hell-ict/content";
import type { GameEvent } from "@hell-ict/domain";
import { computed, onScopeDispose, ref } from "vue";
import type { ComputedRef } from "vue";

import type { Scheduler } from "../ports.js";

/*
 * The red band that slides in when a team enters a stage in trouble (mock #redband, #s3-redband,
 * #s4-redband, #s5-redband). Red is a resource that wears out with use, so the band stays a few
 * seconds and leaves. It is cued only by the events of a command's answer: a reload does not show
 * it again, and the header already holds the values after the effect (V1 decision F).
 */

type BandStage = keyof typeof stageEntryBands;

/** `in` slides in and stays; `out` fades (BAND_FADE_MS) before the band is taken away. */
export type RedBandPhase = "hidden" | "in" | "out";

/**
 * How long each band stays before it fades. Stage 2's is the Stage 1→2 turn of the mock's
 * `transition()` (in at 300 ms, out at 3300 ms); the others are the mock's `s3FlashSurge` …
 * `s5FlashSurge` (2200 ms).
 */
export const BAND_HOLD_MS = {
  s2: 3_000,
  s3: 2_200,
  s4: 2_200,
  s5: 2_200,
} as const satisfies Readonly<Record<BandStage, number>>;

/** The fade out (mock `.redband.out`, 0.4 s). */
export const BAND_FADE_MS = 400;

const isBandStage = (stage: string): stage is BandStage => Object.hasOwn(stageEntryBands, stage);

/** The band a batch of events calls for: the last stage entered that has one. */
export const bandStageOf = (events: readonly GameEvent[]): BandStage | null => {
  let found: BandStage | null = null;
  for (const event of events) {
    if (event.type === "stage-entered" && isBandStage(event.stage)) found = event.stage;
  }
  return found;
};

export interface RedBandDeps {
  readonly scheduler: Scheduler;
  /** Hears each answered command's events (GameSession.onEvents). */
  readonly subscribe: (listener: (events: readonly GameEvent[]) => void) => () => void;
  /** The alarm that goes with the band (mock: `emergency-alert1` as it appears). */
  readonly onShow: () => void;
}

export interface RedBand {
  readonly phase: ComputedRef<RedBandPhase>;
  readonly text: ComputedRef<string>;
}

export const useRedBand = (deps: RedBandDeps): RedBand => {
  const phase = ref<RedBandPhase>("hidden");
  const text = ref("");
  let cancelTimer: () => void = () => undefined;

  const later = (task: () => void, delayMs: number): void => {
    cancelTimer();
    cancelTimer = deps.scheduler.schedule(task, delayMs);
  };

  const show = (stage: BandStage): void => {
    text.value = stageEntryBands[stage];
    phase.value = "in";
    deps.onShow();
    later(() => {
      phase.value = "out";
      later(() => {
        phase.value = "hidden";
      }, BAND_FADE_MS);
    }, BAND_HOLD_MS[stage]);
  };

  const stop = deps.subscribe((events) => {
    const stage = bandStageOf(events);
    if (stage !== null) show(stage);
  });

  onScopeDispose(() => {
    stop();
    cancelTimer();
  });

  return { phase: computed(() => phase.value), text: computed(() => text.value) };
};
