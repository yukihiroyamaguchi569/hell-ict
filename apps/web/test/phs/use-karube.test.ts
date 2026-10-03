import { phsBusyLine } from "@hell-ict/content";
import { describe, expect, it } from "vitest";
import { defineComponent, effectScope, nextTick, ref, shallowRef } from "vue";

import {
  KARUBE_LINE_GAP_MS,
  KARUBE_REPLY_DELAY_MS,
  useKarube,
  useKarubeRecord,
} from "../../src/phs/use-karube.js";
import type { KarubeCall, StageInstance } from "../../src/stages/stage-module.js";
import { FakeKeyValueStorage, FakeScheduler } from "../fakes.js";

const KEY = "hellVueKarube:123456";
const Center = defineComponent({ render: () => null });

const stay = (...calls: KarubeCall[]) => {
  const karube = shallowRef<readonly KarubeCall[]>(calls);
  const instance: StageInstance = { center: Center, karube };
  return { instance, karube };
};

const mount = (storage = new FakeKeyValueStorage(), first = stay()) => {
  const scheduler = new FakeScheduler();
  const teamCode = ref<string | null>("123456");
  const current = shallowRef<StageInstance | null>(first.instance);
  let rings = 0;
  const scope = effectScope();
  const made = scope.run(() => {
    const record = useKarubeRecord(storage, teamCode);
    const phone = useKarube({
      record,
      instance: () => current.value,
      scheduler,
      onRing: () => {
        rings += 1;
      },
    });
    return { record, phone };
  });
  if (made === undefined) throw new Error("the scope did not run");
  return { ...made, scheduler, current, scope, teamCode, rings: () => rings };
};

const texts = (phone: ReturnType<typeof mount>["phone"]) =>
  phone.log.value.map((line) => `${line.kind}:${line.text}`);

const call = (callId: string, ...lines: string[]): KarubeCall => ({ callId, lines });

describe("useKarube", () => {
  it("呼び出しが無いうちは出さず、鳴らさない", () => {
    const { phone, rings } = mount();
    expect(phone.visible.value).toBe(false);
    expect(phone.badge.value).toBeNull();
    expect(rings()).toBe(0);
  });

  it("呼び出しが来たら1回だけ鳴らし、バッジを点け、sessionStorage に鳴らしたことを残す", async () => {
    const storage = new FakeKeyValueStorage();
    const s = stay();
    const { phone, rings } = mount(storage, s);
    s.karube.value = [call("c1", "a")];
    await nextTick();
    expect(rings()).toBe(1);
    expect(phone.visible.value).toBe(true);
    expect(phone.badge.value).toBe(1);
    expect(phone.open.value).toBe(false);
    expect(JSON.parse(storage.values.get(KEY) ?? "null")).toEqual({ rung: ["c1"], read: [] });
  });

  it("開くと最初の行をすぐ、残りを 900ms ごとに1行ずつ出す（899ms ではまだ、900ms ちょうどで出る）", () => {
    const { phone, scheduler, record } = mount(undefined, stay(call("c1", "一", "二", "三")));
    phone.toggle();
    expect(phone.open.value).toBe(true);
    expect(phone.badge.value).toBeNull();
    expect(record.read.value.has("c1")).toBe(true);
    expect(texts(phone)).toEqual(["karube:一"]);
    scheduler.advanceBy(KARUBE_LINE_GAP_MS - 1);
    expect(texts(phone)).toEqual(["karube:一"]);
    scheduler.advanceBy(1);
    expect(texts(phone)).toEqual(["karube:一", "karube:二"]);
    scheduler.advanceBy(KARUBE_LINE_GAP_MS);
    expect(texts(phone)).toEqual(["karube:一", "karube:二", "karube:三"]);
  });

  it("閉じて開き直しても同じ台詞を二度出さない", () => {
    const { phone } = mount(undefined, stay(call("c1", "一")));
    phone.toggle();
    phone.toggle();
    expect(phone.open.value).toBe(false);
    phone.toggle();
    expect(texts(phone)).toEqual(["karube:一"]);
  });

  it("同じ callId が通知し直されても鳴らさず、追記もしない", async () => {
    const s = stay(call("c1", "一"));
    const { phone, rings } = mount(undefined, s);
    phone.toggle();
    s.karube.value = [];
    await nextTick();
    s.karube.value = [call("c1", "一")];
    await nextTick();
    phone.toggle();
    phone.toggle();
    expect(rings()).toBe(1);
    expect(phone.badge.value).toBeNull();
    expect(texts(phone)).toEqual(["karube:一"]);
  });

  it("呼び出しが1件増えたらもう一度鳴らし、ログに追記する（前の台詞は消さない）", async () => {
    const s = stay(call("c1", "一"));
    const { phone, rings } = mount(undefined, s);
    phone.toggle();
    phone.toggle();
    s.karube.value = [call("c1", "一"), call("c2", "二")];
    await nextTick();
    expect(rings()).toBe(2);
    expect(phone.badge.value).toBe(2);
    phone.toggle();
    expect(texts(phone)).toEqual(["karube:一", "karube:二"]);
  });

  it("一覧から前の呼び出しが外れても、このステージの間は未読のまま残す", async () => {
    const s = stay(call("c1", "一"));
    const { phone, scheduler } = mount(undefined, s);
    s.karube.value = [call("c2", "二")];
    await nextTick();
    expect(phone.badge.value).toBe(2);
    phone.toggle();
    scheduler.advanceBy(KARUBE_LINE_GAP_MS);
    expect(texts(phone)).toEqual(["karube:一", "karube:二"]);
  });

  it("同時に2件（again:3 と hint:3）来たら着信音は1回、両方とも着信済みにし、開くと古い順に読める", async () => {
    const storage = new FakeKeyValueStorage();
    const s = stay(call("again:3", "やり直し1", "やり直し2"), call("hint:3", "ヒント"));
    const { phone, scheduler, record, rings } = mount(storage, s);
    expect(rings()).toBe(1);
    expect(record.hasRung("again:3")).toBe(true);
    expect(record.hasRung("hint:3")).toBe(true);
    expect(phone.badge.value).toBe(2);
    phone.toggle();
    scheduler.advanceBy(KARUBE_LINE_GAP_MS * 2);
    expect(texts(phone)).toEqual(["karube:やり直し1", "karube:やり直し2", "karube:ヒント"]);
    expect([...record.read.value]).toEqual(["again:3", "hint:3"]);
    expect(phone.badge.value).toBeNull();
    s.karube.value = [...s.karube.value, call("again:4", "もう一度")];
    await nextTick();
    expect(rings()).toBe(2);
    expect(phone.badge.value).toBe(3);
  });

  it("何も来ていないのに開いたら待ち文言だけを出す", () => {
    const s = stay();
    const { phone } = mount(undefined, s);
    phone.toggle();
    expect(texts(phone)).toEqual([`wait:${phsBusyLine}`]);
  });

  it("返信は〔あなた〕の行として残し、1500ms 後に待ち文言で受け流す。空欄は送らない", () => {
    const { phone, scheduler } = mount(undefined, stay(call("c1", "一")));
    phone.toggle();
    phone.reply("   ");
    expect(texts(phone)).toEqual(["karube:一"]);
    phone.reply(" 了解です ");
    scheduler.advanceBy(KARUBE_REPLY_DELAY_MS - 1);
    expect(texts(phone)).toEqual(["karube:一", "me:了解です"]);
    scheduler.advanceBy(1);
    expect(texts(phone)).toEqual(["karube:一", "me:了解です", `wait:${phsBusyLine}`]);
  });

  it("ステージが変わったら表示の記録を空にし、窓を閉じ、残りの行を出さない", async () => {
    const { phone, scheduler, current } = mount(undefined, stay(call("c1", "一", "二")));
    phone.toggle();
    current.value = stay().instance;
    await nextTick();
    expect(scheduler.pending).toBe(0);
    scheduler.advanceBy(KARUBE_LINE_GAP_MS);
    expect(phone.log.value).toEqual([]);
    expect(phone.open.value).toBe(false);
    expect(phone.visible.value).toBe(false);
  });

  it("次のステージで新しい呼び出しが来ればバッジは1から数える", async () => {
    const { phone, current } = mount(undefined, stay(call("c1", "一")));
    current.value = stay(call("s2", "二")).instance;
    await nextTick();
    expect(phone.badge.value).toBe(1);
  });

  it("再読み込みで同じ callId の着信音を鳴らし直さない。未読ならバッジは点いたまま", () => {
    const storage = new FakeKeyValueStorage();
    mount(storage, stay(call("c1", "一")));
    const reloaded = mount(storage, stay(call("c1", "一")));
    expect(reloaded.rings()).toBe(0);
    expect(reloaded.phone.badge.value).toBe(1);
  });

  it("再読み込み前に読んだ呼び出しはバッジを点けず、開くと全部をまとめて出す", () => {
    const storage = new FakeKeyValueStorage();
    mount(storage, stay(call("c1", "一", "二"))).phone.toggle();
    const { phone, scheduler, rings } = mount(storage, stay(call("c1", "一", "二")));
    expect(rings()).toBe(0);
    expect(phone.badge.value).toBeNull();
    phone.toggle();
    expect(texts(phone)).toEqual(["karube:一", "karube:二"]);
    expect(scheduler.pending).toBe(0);
  });

  it("再読み込み後、既読の again:3 は鳴らし直さず、まだ鳴っていない hint:3 だけ鳴らす。開くと既読分はまとめて、新しい分は1行目から", () => {
    const storage = new FakeKeyValueStorage();
    mount(storage, stay(call("again:3", "やり直し"))).phone.toggle();
    const reloaded = mount(
      storage,
      stay(call("again:3", "やり直し"), call("hint:3", "ヒ1", "ヒ2")),
    );
    expect(reloaded.rings()).toBe(1);
    expect(reloaded.phone.badge.value).toBe(2);
    reloaded.phone.toggle();
    expect(texts(reloaded.phone)).toEqual(["karube:やり直し", "karube:ヒ1"]);
    reloaded.scheduler.advanceBy(KARUBE_LINE_GAP_MS);
    expect(texts(reloaded.phone)).toEqual(["karube:やり直し", "karube:ヒ1", "karube:ヒ2"]);
  });

  it.each([["not json"], ['{"rung":["c1"]}'], ['{"rung":[1],"read":[]}']])(
    "壊れた保存（%s）は捨てて、鳴らしていないものとして扱う",
    (saved) => {
      const storage = new FakeKeyValueStorage();
      storage.values.set(KEY, saved);
      const { rings } = mount(storage, stay(call("c1", "一")));
      expect(rings()).toBe(1);
      expect(JSON.parse(storage.values.get(KEY) ?? "null")).toEqual({ rung: ["c1"], read: [] });
    },
  );

  it("保存がブロックされていてもメモリで覚え、同じ呼び出しを二度鳴らさない", async () => {
    const storage = new FakeKeyValueStorage();
    storage.failing = true;
    const s = stay(call("c1", "一"));
    const { phone, rings } = mount(storage, s);
    s.karube.value = [];
    await nextTick();
    s.karube.value = [call("c1", "一")];
    await nextTick();
    expect(rings()).toBe(1);
    phone.toggle();
    expect(phone.badge.value).toBeNull();
    expect(texts(phone)).toEqual(["karube:一"]);
  });

  it("チームが替わったら、そのチームの記録を読み直す", async () => {
    const storage = new FakeKeyValueStorage();
    storage.values.set("hellVueKarube:654321", '{"rung":["x"],"read":["x"]}');
    const { record, teamCode } = mount(storage);
    record.markRead("c1");
    teamCode.value = "654321";
    await nextTick();
    expect([...record.read.value]).toEqual(["x"]);
    expect(record.hasRung("c1")).toBe(false);
  });

  it("スコープが止まったら予約した行を取り消す", () => {
    const { phone, scheduler, scope } = mount(undefined, stay(call("c1", "一", "二")));
    phone.toggle();
    scope.stop();
    expect(scheduler.pending).toBe(0);
  });
});
