import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { useMailRead } from "../../src/inbox/use-mail-read.js";
import { FakeKeyValueStorage } from "../fakes.js";

const KEY = "hellVueRead:123456";

const mount = (storage: FakeKeyValueStorage, code: string | null = "123456") => {
  const teamCode = ref<string | null>(code);
  const read = effectScope().run(() => useMailRead(storage, teamCode));
  if (read === undefined) throw new Error("the scope did not run");
  return { read, teamCode };
};

describe("useMailRead", () => {
  it("開いたメールを覚え、sessionStorage に残す", () => {
    const storage = new FakeKeyValueStorage();
    const { read } = mount(storage);
    read.markRead("m1");
    read.markRead("m2");
    expect([...read.readIds.value]).toEqual(["m1", "m2"]);
    expect(storage.values.get(KEY)).toBe('["m1","m2"]');
  });

  it("再読み込み（作り直し）で既読が戻る", () => {
    const storage = new FakeKeyValueStorage();
    storage.values.set(KEY, '["m1"]');
    expect([...mount(storage).read.readIds.value]).toEqual(["m1"]);
  });

  it("同じメールを2回開いても1件で、書き直さない", () => {
    const storage = new FakeKeyValueStorage();
    const { read } = mount(storage);
    read.markRead("m1");
    const before = read.readIds.value;
    read.markRead("m1");
    expect(read.readIds.value).toBe(before);
  });

  it.each([["not json"], ['{"m1":true}'], ["[1,2]"]])(
    "壊れた保存（%s）は捨てて未読から始める",
    (saved) => {
      const storage = new FakeKeyValueStorage();
      storage.values.set(KEY, saved);
      expect(mount(storage).read.readIds.value.size).toBe(0);
      expect(storage.values.has(KEY)).toBe(false);
    },
  );

  it("保存が使えなくても（ブロック）メモリで既読を覚える", () => {
    const storage = new FakeKeyValueStorage();
    storage.failing = true;
    const { read } = mount(storage);
    read.markRead("m1");
    expect(read.readIds.value.has("m1")).toBe(true);
  });

  it("チームが替わったら、そのチームの既読を読み直す（他チームの既読を持ち越さない）", async () => {
    const storage = new FakeKeyValueStorage();
    storage.values.set("hellVueRead:654321", '["x"]');
    const { read, teamCode } = mount(storage);
    read.markRead("m1");
    teamCode.value = "654321";
    await nextTick();
    expect([...read.readIds.value]).toEqual(["x"]);
    read.markRead("y");
    expect(storage.values.get(KEY)).toBe('["m1"]');
  });

  it("チームが無い間は覚えるだけで保存しない", () => {
    const storage = new FakeKeyValueStorage();
    const { read } = mount(storage, null);
    read.markRead("m1");
    expect(read.readIds.value.has("m1")).toBe(true);
    expect(storage.values.size).toBe(0);
  });
});
