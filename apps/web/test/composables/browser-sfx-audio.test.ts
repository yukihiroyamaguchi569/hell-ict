import { describe, expect, it } from "vitest";

import { createBrowserSfxAudio, type SfxElement } from "../../src/composables/use-sfx.js";
import type { Tone } from "../../src/ports.js";

type Failure = "none" | "volume" | "seek" | "play-throws" | "play-rejects" | "pause";

class FakeElement implements SfxElement {
  preload = "";
  plays = 0;
  pauses = 0;
  private currentVolume = 1;

  constructor(
    readonly src: string,
    private readonly failure: Failure,
  ) {}

  get volume(): number {
    return this.currentVolume;
  }

  set volume(value: number) {
    if (this.failure === "volume") throw new RangeError("IndexSizeError");
    this.currentVolume = value;
  }

  get currentTime(): number {
    return 0;
  }

  set currentTime(_value: number) {
    if (this.failure === "seek") throw new Error("InvalidStateError");
  }

  play(): Promise<void> {
    this.plays += 1;
    if (this.failure === "play-throws") throw new Error("NotSupportedError");
    if (this.failure === "play-rejects") return Promise.reject(new Error("NotAllowedError"));
    return Promise.resolve();
  }

  pause(): void {
    this.pauses += 1;
    if (this.failure === "pause") throw new Error("pause failed");
  }

  readyState = 0;
  private readonly listeners: { type: string; listener: () => void }[] = [];

  addEventListener(type: "error" | "canplaythrough", listener: () => void): void {
    this.listeners.push({ type, listener });
  }

  /** The browser's load outcome: each `once` listener of that type runs one time. */
  emit(type: "error" | "canplaythrough"): void {
    const due = this.listeners.filter((entry) => entry.type === type);
    for (const entry of due) this.listeners.splice(this.listeners.indexOf(entry), 1);
    for (const entry of due) entry.listener();
  }
}

const withFailure = (failure: Failure) => {
  const created: FakeElement[] = [];
  const audio = createBrowserSfxAudio((src) => {
    const element = new FakeElement(src, failure);
    created.push(element);
    return element;
  });
  return { audio, created };
};

/** Lets rejected promises settle, so an unhandled rejection would fail the test run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createBrowserSfxAudio", () => {
  it("音ごとに1つの要素を作り、/sounds/<name>.mp3 を頭から鳴らす", async () => {
    const { audio, created } = withFailure("none");
    audio.play("success1", 0.4);
    audio.play("success1", 0.3);
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]?.src).toBe("/sounds/success1.mp3");
    expect(created[0]?.preload).toBe("auto");
    expect(created[0]?.plays).toBe(2);
    expect(created[0]?.volume).toBe(0.3);
  });

  it("要素を作れなくても例外を外へ出さない", () => {
    const audio = createBrowserSfxAudio(() => {
      throw new Error("Audio is not supported");
    });
    expect(() => {
      audio.play("don-1", 0.4);
      audio.stopAll();
    }).not.toThrow();
  });

  it.each(["volume", "seek", "play-throws"] as const)(
    "%s の同期例外を外へ出さない",
    async (failure) => {
      const { audio } = withFailure(failure);
      expect(() => {
        audio.play("cancel", 0.4);
      }).not.toThrow();
      await settle();
    },
  );

  it("play() の Promise 拒否を握りつぶす（未処理の拒否を残さない）", async () => {
    const { audio, created } = withFailure("play-rejects");
    audio.play("decision1", 0.25);
    await settle();
    expect(created[0]?.plays).toBe(1);
  });

  it("停止に失敗する要素があっても、ほかの要素は止める", () => {
    const failing = withFailure("pause");
    failing.audio.play("cancel", 0.4);
    failing.audio.play("don-1", 0.4);
    expect(() => {
      failing.audio.stopAll();
    }).not.toThrow();
    expect(failing.created.map((element) => element.pauses)).toEqual([1, 1]);
  });

  it("合成音は音のファイルを作らず、合成器へそのまま渡す", () => {
    const created: string[] = [];
    const tones: Tone[] = [];
    const audio = createBrowserSfxAudio(
      (src) => {
        created.push(src);
        return new FakeElement(src, "none");
      },
      (tone) => tones.push(tone),
    );
    const beep: Tone = { frequencyHz: 988, durationMs: 70, volume: 0.12 };
    audio.tone(beep);
    expect(tones).toEqual([beep]);
    expect(created).toEqual([]);
  });
});

describe("createBrowserSfxAudio の先読み（Issue #379）", () => {
  it("最後まで鳴らせる所まで読めたら loaded。鳴らすときは同じ要素を使い、取り直さない", async () => {
    const { audio, created } = withFailure("none");
    const result = audio.preload("don-1");
    created[0]?.emit("canplaythrough");
    await expect(result).resolves.toBe("loaded");
    audio.play("don-1", 0.4);
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]?.src).toBe("/sounds/don-1.mp3");
    expect(created[0]?.preload).toBe("auto");
    expect(created[0]?.plays).toBe(1);
  });

  it("読み終えている要素（readyState 4）は待たずに loaded", async () => {
    const { audio, created } = withFailure("none");
    audio.play("cancel", 0.4);
    if (created[0] !== undefined) created[0].readyState = 4;
    await expect(audio.preload("cancel")).resolves.toBe("loaded");
    expect(created).toHaveLength(1);
  });

  it("読み込みに失敗したら failed。拒否はしない", async () => {
    const { audio, created } = withFailure("none");
    const result = audio.preload("success1");
    created[0]?.emit("error");
    await expect(result).resolves.toBe("failed");
  });

  it("失敗した要素は捨て、次に鳴らすときに取り直す（使う時点での取得に任せる）", async () => {
    const { audio, created } = withFailure("none");
    const result = audio.preload("success1");
    created[0]?.emit("error");
    await result;
    audio.play("success1", 0.4);
    await settle();
    expect(created).toHaveLength(2);
    expect(created[0]?.plays).toBe(0);
    expect(created[1]?.plays).toBe(1);
  });

  it("鳴らしている途中で失敗した要素も捨て、次の先読みで取り直す", async () => {
    const { audio, created } = withFailure("none");
    audio.play("decision1", 0.25);
    created[0]?.emit("error");
    const result = audio.preload("decision1");
    created[1]?.emit("canplaythrough");
    await expect(result).resolves.toBe("loaded");
    expect(created).toHaveLength(2);
  });

  it("読み込み中は解決しない（終わりの合図を待つ）", async () => {
    const { audio } = withFailure("none");
    let done = false;
    void audio.preload("don-1").then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
  });

  it("要素を作れなくても例外も拒否も出さず failed", async () => {
    const audio = createBrowserSfxAudio(() => {
      throw new Error("Audio is not supported");
    });
    await expect(audio.preload("don-1")).resolves.toBe("failed");
  });
});
