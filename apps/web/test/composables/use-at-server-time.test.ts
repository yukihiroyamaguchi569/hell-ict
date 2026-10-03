import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import {
  dueMomentKey,
  useAtServerTime,
  type ServerMoment,
} from "../../src/composables/use-at-server-time.js";

describe("dueMomentKey", () => {
  const moment = { key: "settle:1", at: 1_000 };

  it("指定時刻の前は null、ちょうど達したらキー", () => {
    expect(dueMomentKey(moment, 999, new Set())).toBeNull();
    expect(dueMomentKey(moment, 1_000, new Set())).toBe("settle:1");
    expect(dueMomentKey(moment, 5_000, new Set())).toBe("settle:1");
  });

  it("済んだキーと、時刻の無いときは null", () => {
    expect(dueMomentKey(moment, 1_000, new Set(["settle:1"]))).toBeNull();
    expect(dueMomentKey(null, 1_000, new Set())).toBeNull();
  });
});

const setup = (startMs: number, initial: ServerMoment | null) => {
  const now = ref(startMs);
  const moment = ref<ServerMoment | null>(initial);
  const runs: string[] = [];
  const scope = effectScope();
  scope.run(() => {
    useAtServerTime(
      now,
      () => moment.value,
      (key) => runs.push(key),
    );
  });
  return { now, moment, runs, scope };
};

describe("useAtServerTime", () => {
  it("サーバ時刻が達したら1回だけ呼び、その後の刻みでは呼ばない", async () => {
    const { now, runs } = setup(0, { key: "a", at: 1_000 });
    now.value = 999;
    await nextTick();
    expect(runs).toEqual([]);
    now.value = 1_000;
    await nextTick();
    expect(runs).toEqual(["a"]);
    for (const ms of [1_250, 1_500, 60_000]) {
      now.value = ms;
      await nextTick();
    }
    expect(runs).toEqual(["a"]);
  });

  it("画面が出た時点で過ぎていれば、すぐに1回だけ呼ぶ（再読み込み）", async () => {
    const { now, runs } = setup(10_000, { key: "a", at: 1_000 });
    expect(runs).toEqual(["a"]);
    now.value = 10_250;
    await nextTick();
    expect(runs).toEqual(["a"]);
  });

  it("キーが変われば新しい時刻でもう1回。前のキーへ戻っても呼び直さない", async () => {
    const { now, moment, runs } = setup(0, { key: "r1", at: 1_000 });
    now.value = 1_000;
    await nextTick();
    moment.value = { key: "r2", at: 2_000 };
    await nextTick();
    expect(runs).toEqual(["r1"]);
    now.value = 2_000;
    await nextTick();
    expect(runs).toEqual(["r1", "r2"]);
    moment.value = { key: "r1", at: 1_000 };
    await nextTick();
    expect(runs).toEqual(["r1", "r2"]);
  });

  it("同じキーのまま時刻が後ろへずれても、済んだものは呼ばない", async () => {
    const { now, moment, runs } = setup(1_000, { key: "a", at: 1_000 });
    moment.value = { key: "a", at: 5_000 };
    now.value = 5_000;
    await nextTick();
    expect(runs).toEqual(["a"]);
  });

  it("時刻が無い（null）間は呼ばない", async () => {
    const { now, moment, runs } = setup(0, null);
    now.value = 99_000;
    await nextTick();
    expect(runs).toEqual([]);
    moment.value = { key: "a", at: 1_000 };
    await nextTick();
    expect(runs).toEqual(["a"]);
  });

  it("破棄した後は呼ばない", async () => {
    const { now, runs, scope } = setup(0, { key: "a", at: 1_000 });
    scope.stop();
    now.value = 1_000;
    await nextTick();
    expect(runs).toEqual([]);
  });
});
