import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { SERVER_NOW_TICK_MS, useServerNow } from "../../src/composables/use-server-now.js";
import { FakeScheduler } from "../fakes.js";

/** A server clock whose PC time and offset the test sets by hand. */
const fakeServerClock = (pcNow: { value: number }) => {
  const offsetMs = ref(0);
  return { offsetMs, now: () => pcNow.value + offsetMs.value };
};

describe("useServerNow", () => {
  it("作った時点の時刻を持ち、250ms ごとに読み直す", () => {
    const pc = { value: 1_000 };
    const scheduler = new FakeScheduler();
    const scope = effectScope();
    const current = scope.run(() => useServerNow(fakeServerClock(pc), scheduler));
    expect(current?.value).toBe(1_000);
    pc.value = 1_300;
    scheduler.advanceBy(SERVER_NOW_TICK_MS - 1);
    expect(current?.value).toBe(1_000);
    scheduler.advanceBy(1);
    expect(current?.value).toBe(1_300);
    pc.value = 1_550;
    scheduler.advanceBy(SERVER_NOW_TICK_MS);
    expect(current?.value).toBe(1_550);
    expect(scheduler.pending).toBe(1);
  });

  it("サーバとの差が分かったら、次の読み直しを待たずに補正した時刻にする", async () => {
    const pc = { value: 1_000 };
    const clock = fakeServerClock(pc);
    const scheduler = new FakeScheduler();
    const scope = effectScope();
    const current = scope.run(() => useServerNow(clock, scheduler));
    clock.offsetMs.value = 600_000;
    await nextTick();
    expect(current?.value).toBe(601_000);
    expect(scheduler.pending).toBe(1);
  });

  it("破棄したら読み直しを止める", async () => {
    const pc = { value: 0 };
    const clock = fakeServerClock(pc);
    const scheduler = new FakeScheduler();
    const scope = effectScope();
    const current = scope.run(() => useServerNow(clock, scheduler));
    scheduler.advanceBy(SERVER_NOW_TICK_MS);
    scope.stop();
    expect(scheduler.pending).toBe(0);
    clock.offsetMs.value = 5;
    await nextTick();
    expect(current?.value).toBe(0);
  });
});
