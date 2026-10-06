import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { sfxVolume, useSfx } from "../../src/composables/use-sfx.js";
import type { AudioPort, PreloadResult, Tone } from "../../src/ports.js";

class FakeAudio implements AudioPort {
  readonly played: [string, number][] = [];
  readonly tones: Tone[] = [];
  stops = 0;

  play(name: string, volume: number): void {
    this.played.push([name, volume]);
  }

  tone(tone: Tone): void {
    this.tones.push(tone);
  }

  stopAll(): void {
    this.stops += 1;
  }

  preload(): Promise<PreloadResult> {
    return Promise.resolve("loaded");
  }
}

/** An EventTarget that knows how many listeners are still registered. */
class CountingTarget extends EventTarget {
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (callback === null) return;
    const once = typeof options === "object" && options.once === true;
    const tracked: EventListener = (event) => {
      if (once) this.listeners.delete(callback);
      if (typeof callback === "function") callback(event);
      else callback.handleEvent(event);
    };
    this.listeners.add(callback);
    this.wrapped.set(callback, tracked);
    super.addEventListener(type, tracked, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (callback === null) return;
    super.removeEventListener(type, this.wrapped.get(callback) ?? null, options);
    this.listeners.delete(callback);
  }

  private readonly wrapped = new Map<EventListenerOrEventListenerObject, EventListener>();
}

const setup = (muted = false) => {
  const audio = new FakeAudio();
  const mutedRef = ref(muted);
  const target = new CountingTarget();
  const scope = effectScope();
  const sfx = scope.run(() => useSfx(audio, mutedRef, target));
  if (sfx === undefined) throw new Error("the scope did not run");
  const click = (): void => {
    target.dispatchEvent(new Event("click"));
  };
  return { audio, muted: mutedRef, sfx, click, target, scope };
};

describe("useSfx", () => {
  it("最初のクリックまでは鳴らさない（ブラウザの自動再生制限）", () => {
    const { audio, sfx, click } = setup();
    sfx.play("success1");
    expect(audio.played).toHaveLength(0);
    click();
    sfx.play("success1");
    expect(audio.played).toEqual([["success1", 0.4]]);
  });

  it("ミュート中は再生を1回も呼ばない", () => {
    const { audio, sfx, click } = setup(true);
    click();
    for (const name of ["success1", "decision1", "don-1"] as const) sfx.play(name);
    expect(audio.played).toHaveLength(0);
  });

  it("ミュートを外せば次の音から鳴る", async () => {
    const { audio, muted, sfx, click } = setup(true);
    click();
    sfx.play("cancel");
    muted.value = false;
    await nextTick();
    sfx.play("cancel");
    expect(audio.played).toEqual([["cancel", 0.4]]);
  });

  it("ミュートにした瞬間、鳴っている音も止める", async () => {
    const { audio, muted } = setup();
    muted.value = true;
    await nextTick();
    expect(audio.stops).toBe(1);
    muted.value = false;
    await nextTick();
    expect(audio.stops).toBe(1);
  });

  it("クリックが何度あっても、解禁は1回で済み挙動は変わらない", () => {
    const { audio, sfx, click } = setup();
    click();
    click();
    sfx.play("don-1");
    expect(audio.played).toHaveLength(1);
  });
});

describe("useSfx の合成音（tone）", () => {
  const beep: Tone = { frequencyHz: 880, durationMs: 70, volume: 0.12 };

  it("最初のクリックまでは鳴らさず、クリック後はそのまま audio.tone へ渡す", () => {
    const { audio, sfx, click } = setup();
    sfx.tone(beep);
    expect(audio.tones).toEqual([]);
    click();
    sfx.tone(beep);
    expect(audio.tones).toEqual([beep]);
  });

  it("ミュート中は1回も鳴らさず、外せば次から鳴る", async () => {
    const { audio, muted, sfx, click } = setup(true);
    click();
    sfx.tone(beep);
    expect(audio.tones).toEqual([]);
    muted.value = false;
    await nextTick();
    sfx.tone(beep);
    expect(audio.tones).toEqual([beep]);
  });
});

describe("useSfx の後始末", () => {
  it("最初のクリックの前に破棄されたら、クリック待ちのリスナーを外す", () => {
    const { target, scope } = setup();
    expect(target.listenerCount).toBe(1);
    scope.stop();
    expect(target.listenerCount).toBe(0);
  });

  it("クリックで解禁済みのあとに破棄しても例外を出さず、リスナーは残らない", () => {
    const { target, scope, click } = setup();
    click();
    expect(target.listenerCount).toBe(0);
    expect(() => {
      scope.stop();
    }).not.toThrow();
    expect(target.listenerCount).toBe(0);
  });
});

describe("sfxVolume", () => {
  it("既定は 0.4、メール着弾（decision1）だけ 0.25", () => {
    expect(sfxVolume("success1")).toBe(0.4);
    expect(sfxVolume("decision1")).toBe(0.25);
  });

  it("用途ごとの音量を渡したらそれを使い、0 は無音として尊重する", () => {
    expect(sfxVolume("decision1", 0.8)).toBe(0.8);
    expect(sfxVolume("success1", 0)).toBe(0);
  });
});
