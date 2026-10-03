import type { GameStageId } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { useClearPortraitPreload } from "../../src/composables/use-clear-portrait-preload.js";
import { clearPortraitSrcs } from "../../src/overlays/clear-sheets.js";
import type { ImagePreloader, PreloadResult } from "../../src/ports.js";
import { FakeResumeSignal } from "../fakes.js";

class FakePreloader implements ImagePreloader {
  readonly requested: string[] = [];

  preload(src: string): Promise<PreloadResult> {
    this.requested.push(src);
    return Promise.resolve("loaded");
  }
}

const setup = (initial: GameStageId | null) => {
  const stage = ref<GameStageId | null>(initial);
  const preloader = new FakePreloader();
  const resume = new FakeResumeSignal();
  const scope = effectScope();
  scope.run(() => {
    useClearPortraitPreload({ stage: () => stage.value, preloader, resume });
  });
  return { stage, preloader, resume, scope };
};

describe("useClearPortraitPreload", () => {
  it("ステージに居る状態で開いたら、すぐにそのステージのクリア演出の肖像を先読みする", () => {
    const { preloader } = setup("s5");
    expect(preloader.requested).toEqual(clearPortraitSrcs("s5"));
    expect(preloader.requested).toHaveLength(2);
  });

  it("先読みするのは②③の全画面の絵（そのステージの2枚だけ）", () => {
    const { preloader } = setup("s5");
    expect(preloader.requested).toEqual([
      "/assets/images/production/stage5-ward-5b-head-nurse-clear.webp",
      "/assets/images/production/stage5-administrative-director-clear.webp",
    ]);
  });

  it("次のステージに入ったら、そのステージの肖像を先読みする", async () => {
    const { stage, preloader } = setup("s4");
    stage.value = "s5";
    await nextTick();
    expect(preloader.requested).toEqual([...clearPortraitSrcs("s4"), ...clearPortraitSrcs("s5")]);
  });

  it("同じステージのまま再取得されても、先読みを繰り返さない", async () => {
    const { stage, preloader } = setup("s2");
    stage.value = "s2";
    await nextTick();
    expect(preloader.requested).toEqual(clearPortraitSrcs("s2"));
  });

  it("入室前（view が無い）と Prologue・Final では何も先読みしない", async () => {
    const { stage, preloader } = setup(null);
    stage.value = "prologue";
    await nextTick();
    stage.value = "final";
    await nextTick();
    expect(preloader.requested).toEqual([]);
  });

  it("Prologue から Stage 1 に入った時点で Stage 1 の肖像を先読みする", async () => {
    const { stage, preloader } = setup("prologue");
    stage.value = "s1";
    await nextTick();
    expect(preloader.requested).toEqual(clearPortraitSrcs("s1"));
  });

  it("タブが戻る・通信が戻ると、今のステージの肖像をもう一度先読みする（オフライン中の失敗を取り戻す）", async () => {
    const { stage, preloader, resume } = setup("s4");
    stage.value = "s5";
    await nextTick();
    resume.fire();
    expect(preloader.requested).toEqual([
      ...clearPortraitSrcs("s4"),
      ...clearPortraitSrcs("s5"),
      ...clearPortraitSrcs("s5"),
    ]);
  });

  it("入室前・Final で戻っても何も先読みしない", async () => {
    const { stage, preloader, resume } = setup(null);
    resume.fire();
    stage.value = "final";
    await nextTick();
    resume.fire();
    expect(preloader.requested).toEqual([]);
  });

  it("画面を閉じた（scope を破棄した）後は、ステージが変わっても戻っても先読みしない", async () => {
    const { stage, preloader, resume, scope } = setup("s1");
    scope.stop();
    expect(resume.listeners.size).toBe(0);
    stage.value = "s2";
    await nextTick();
    resume.fire();
    expect(preloader.requested).toEqual(clearPortraitSrcs("s1"));
  });
});
