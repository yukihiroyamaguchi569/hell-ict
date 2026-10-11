import { describe, expect, it } from "vitest";
import { computed, effectScope } from "vue";

import { openingWanted } from "../../src/opening/opening-view.js";
import { OPENING_MIN_MS, useOpeningMinimum } from "../../src/opening/use-opening-minimum.js";
import { OPENING_LIMIT_MS, useOpeningPreload } from "../../src/opening/use-opening-preload.js";
import type { PreloadResult } from "../../src/ports.js";
import { FakeScheduler, flush } from "../fakes.js";

const setup = () => {
  const scheduler = new FakeScheduler();
  const scope = effectScope();
  const minimumShown = scope.run(() => useOpeningMinimum(scheduler));
  if (minimumShown === undefined) throw new Error("the scope did not run");
  return { scheduler, scope, minimumShown };
};

describe("useOpeningMinimum", () => {
  it("3秒の直前までは false、3秒ちょうどで true になり、以後は戻らない", () => {
    const { scheduler, minimumShown } = setup();
    expect(OPENING_MIN_MS).toBe(3_000);
    expect(scheduler.delays).toEqual([OPENING_MIN_MS]);
    expect(minimumShown.value).toBe(false);
    scheduler.advanceBy(OPENING_MIN_MS - 1);
    expect(minimumShown.value).toBe(false);
    scheduler.advanceBy(1);
    expect(minimumShown.value).toBe(true);
    scheduler.advanceBy(OPENING_LIMIT_MS);
    expect(minimumShown.value).toBe(true);
  });

  it("最低表示時間は15秒の上限より短い（上限で読み終わったら、そのまま入室画面へ進める）", () => {
    expect(OPENING_MIN_MS).toBeLessThan(OPENING_LIMIT_MS);
  });

  it("画面を閉じた（scope を破棄した）らタイマーを取り消す", () => {
    const { scheduler, scope, minimumShown } = setup();
    scope.stop();
    expect(scheduler.pending).toBe(0);
    scheduler.advanceBy(OPENING_MIN_MS);
    expect(minimumShown.value).toBe(false);
  });
});

/**
 * The opening as App.vue wires it: the preload of one image (the backdrop itself) and the minimum
 * time, on one fake scheduler. `load` answers the image.
 */
const wiredOpening = () => {
  const scheduler = new FakeScheduler();
  let answer: (result: PreloadResult) => void = () => undefined;
  const image = new Promise<PreloadResult>((resolve) => {
    answer = resolve;
  });
  const scope = effectScope();
  const shown = scope.run(() => {
    const preload = useOpeningPreload({
      backdrop: "/a.webp",
      assets: [{ kind: "image", src: "/a.webp" }],
      images: { preload: () => image },
      audio: { preload: () => image },
      scheduler,
    });
    const minimumShown = useOpeningMinimum(scheduler);
    return computed(() =>
      openingWanted({
        savedTeam: false,
        finished: preload.finished.value,
        minimumShown: minimumShown.value,
      }),
    );
  });
  if (shown === undefined) throw new Error("the scope did not run");
  const load = async (): Promise<void> => {
    answer("loaded");
    await flush();
  };
  return { scheduler, shown, load };
};

describe("オープニングが消える時刻", () => {
  it("読み込みが3秒より速ければ、3秒ちょうどで消える", async () => {
    const { scheduler, shown, load } = wiredOpening();
    scheduler.advanceBy(100);
    await load();
    expect(shown.value).toBe(true);
    scheduler.advanceBy(OPENING_MIN_MS - 101);
    expect(shown.value).toBe(true);
    scheduler.advanceBy(1);
    expect(shown.value).toBe(false);
  });

  it("読み込みが3秒より遅ければ、読み終わった時点で消える", async () => {
    const { scheduler, shown, load } = wiredOpening();
    scheduler.advanceBy(OPENING_MIN_MS + 2_000);
    expect(shown.value).toBe(true);
    await load();
    expect(shown.value).toBe(false);
  });

  it("読み終わらなければ、15秒の直前まで出し続け、15秒で消える", () => {
    const { scheduler, shown } = wiredOpening();
    scheduler.advanceBy(OPENING_LIMIT_MS - 1);
    expect(shown.value).toBe(true);
    scheduler.advanceBy(1);
    expect(shown.value).toBe(false);
  });
});
