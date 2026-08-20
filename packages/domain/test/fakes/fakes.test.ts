import { describe, expect, it } from "vitest";

import {
  FakeAiGateway,
  FakeClock,
  FakeIdGenerator,
  FakeRandom,
  FakeStorage,
} from "../../src/fakes/index.js";

describe("開発用Fake", () => {
  it("時刻、乱数、IDを決定的に差し替える", () => {
    const initialTime = new Date("2026-08-20T00:00:00.000Z");
    const clock = new FakeClock(initialTime);
    const random = new FakeRandom([0.25]);
    const ids = new FakeIdGenerator(["test-id"]);

    initialTime.setUTCFullYear(2030);
    clock.advanceBy(1_000);

    expect(clock.now().toISOString()).toBe("2026-08-20T00:00:01.000Z");
    expect(random.next()).toBe(0.25);
    expect(ids.next()).toBe("test-id");
    expect(() => ids.next()).toThrow("不足");
  });

  it("AIの成功、失敗、タイムアウトを再現する", async () => {
    const gateway = new FakeAiGateway([
      { kind: "success", response: "確認済み" },
      { kind: "failure", error: new Error("rate limited") },
      { kind: "timeout" },
    ]);
    const request = { prompt: "test", timeoutMs: 500 };

    await expect(gateway.complete(request)).resolves.toBe("確認済み");
    await expect(gateway.complete(request)).rejects.toThrow("rate limited");
    await expect(gateway.complete(request)).rejects.toThrow("500ms");
    expect(gateway.requests).toHaveLength(3);
  });

  it("結果が尽きたAI呼び出しを記録し、Promise rejectとして返す", async () => {
    const gateway = new FakeAiGateway([]);
    const request = { prompt: "test", timeoutMs: 500 };

    await expect(gateway.complete(request)).rejects.toThrow("結果が設定されていません");
    expect(gateway.requests).toEqual([request]);
  });

  it("保存失敗後に副作用を残さず、次の保存を許可する", async () => {
    const storage = new FakeStorage<string>();
    storage.failNextSave(new Error("保存に失敗しました"));

    await expect(storage.save("message", "失敗値")).rejects.toThrow("保存に失敗しました");
    await expect(storage.load("message")).resolves.toBeUndefined();
    await expect(storage.save("message", "成功値")).resolves.toBeUndefined();
    await expect(storage.load("message")).resolves.toBe("成功値");
  });
});
