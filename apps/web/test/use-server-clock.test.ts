import { FakeClock } from "@hell-ict/domain/fakes";
import { describe, expect, it } from "vitest";

import { useServerClock } from "../src/composables/use-server-clock.js";

const START_MS = Date.parse("2026-10-31T01:00:00.000Z");

describe("useServerClock", () => {
  it("応答を受けるまでは、この PC の時計をそのまま使う", () => {
    const clock = new FakeClock(new Date(START_MS));
    const serverClock = useServerClock(clock);
    expect(serverClock.offsetMs.value).toBe(0);
    expect(serverClock.now()).toBe(START_MS);
  });

  it("往復の中点でサーバが時計を読んだとみなして差を測る", () => {
    const clock = new FakeClock(new Date(START_MS));
    const serverClock = useServerClock(clock);
    clock.advanceBy(400);
    serverClock.record(START_MS, START_MS + 10_000);
    expect(serverClock.offsetMs.value).toBe(10_000 - 200);
    clock.advanceBy(1_000);
    expect(serverClock.now()).toBe(START_MS + 1_400 + 9_800);
  });

  it("サーバが遅れていれば差は負になる", () => {
    const clock = new FakeClock(new Date(START_MS));
    const serverClock = useServerClock(clock);
    serverClock.record(START_MS, START_MS - 30_000);
    expect(serverClock.offsetMs.value).toBe(-30_000);
    expect(serverClock.now()).toBe(START_MS - 30_000);
  });

  it("測り直すたびに最新の差へ置き換える", () => {
    const clock = new FakeClock(new Date(START_MS));
    const serverClock = useServerClock(clock);
    serverClock.record(START_MS, START_MS + 5_000);
    serverClock.record(START_MS, START_MS + 1_000);
    expect(serverClock.offsetMs.value).toBe(1_000);
  });
});
