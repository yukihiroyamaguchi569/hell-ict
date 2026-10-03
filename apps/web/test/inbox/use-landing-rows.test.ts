import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import type { InboxDraw } from "../../src/inbox/inbox-view.js";
import { LANDING_MS, useLandingRows } from "../../src/inbox/use-landing-rows.js";
import { FakeScheduler } from "../fakes.js";

const setup = (first: InboxDraw) => {
  const scheduler = new FakeScheduler();
  const draw = ref<InboxDraw>(first);
  const scope = effectScope();
  const landing = scope.run(() => useLandingRows(() => draw.value, scheduler));
  if (landing === undefined) throw new Error("scope did not run");
  const redraw = async (next: InboxDraw): Promise<void> => {
    draw.value = next;
    await nextTick();
  };
  return { scheduler, landing, redraw, scope, ids: () => [...landing.value] };
};

describe("useLandingRows", () => {
  it("初回の描画では揺らさず、タイマーも置かない", () => {
    const { ids, scheduler } = setup({ stage: "s2", ids: ["a", "b"] });
    expect(ids()).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it("届いた行は揺れ、animationend が来なくても 550ms で外れる", async () => {
    const { ids, scheduler, redraw } = setup({ stage: "s2", ids: ["a"] });
    await redraw({ stage: "s2", ids: ["b", "a"] });
    expect(ids()).toEqual(["b"]);
    scheduler.advanceBy(LANDING_MS - 1);
    expect(ids()).toEqual(["b"]);
    scheduler.advanceBy(1);
    expect(ids()).toEqual([]);
  });

  it("揺れの途中の再描画では揺れを続け、タイマーを重ねない", async () => {
    const { ids, scheduler, redraw } = setup({ stage: "s2", ids: ["a"] });
    await redraw({ stage: "s2", ids: ["b", "a"] });
    await redraw({ stage: "s2", ids: ["b", "a"] });
    expect(ids()).toEqual(["b"]);
    expect(scheduler.pending).toBe(1);
  });

  it("続けて届いた行は、それぞれの時間で外れる", async () => {
    const { ids, scheduler, redraw } = setup({ stage: "s2", ids: ["a"] });
    await redraw({ stage: "s2", ids: ["b", "a"] });
    scheduler.advanceBy(300);
    await redraw({ stage: "s2", ids: ["c", "b", "a"] });
    expect(ids()).toEqual(["c", "b"]);
    scheduler.advanceBy(LANDING_MS - 300);
    expect(ids()).toEqual(["c"]);
    scheduler.advanceBy(300);
    expect(ids()).toEqual([]);
  });

  it("揺れの途中でステージが変わると即座に外れる", async () => {
    const { ids, redraw } = setup({ stage: "s2", ids: ["a"] });
    await redraw({ stage: "s2", ids: ["b", "a"] });
    await redraw({ stage: "s3", ids: ["b", "x"] });
    expect(ids()).toEqual([]);
  });

  it("アンマウント（スコープ停止）でタイマーを解除する", async () => {
    const { scheduler, redraw, scope } = setup({ stage: "s2", ids: ["a"] });
    await redraw({ stage: "s2", ids: ["b", "a"] });
    expect(scheduler.pending).toBe(1);
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});
