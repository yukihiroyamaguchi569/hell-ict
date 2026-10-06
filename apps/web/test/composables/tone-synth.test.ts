import { describe, expect, it } from "vitest";

import {
  createToneSynth,
  TONE_ATTACK_S,
  type ToneContext,
  type ToneDestination,
  type ToneGain,
  type ToneOscillator,
  type ToneParam,
} from "../../src/composables/tone-synth.js";
import type { Tone } from "../../src/ports.js";

type Call = [string, number, number];

class FakeParam implements ToneParam {
  readonly calls: Call[] = [];
  setValueAtTime(value: number, at: number): void {
    this.calls.push(["set", value, at]);
  }
  linearRampToValueAtTime(value: number, at: number): void {
    this.calls.push(["linear", value, at]);
  }
  exponentialRampToValueAtTime(value: number, at: number): void {
    this.calls.push(["exponential", value, at]);
  }
}

class FakeGain implements ToneGain {
  readonly gain = new FakeParam();
  readonly connected: ToneDestination[] = [];
  connect(destination: ToneDestination): void {
    this.connected.push(destination);
  }
}

class FakeOscillator implements ToneOscillator {
  type: OscillatorType = "square";
  readonly frequency = new FakeParam();
  readonly connected: ToneDestination[] = [];
  started: number | null = null;
  stopped: number | null = null;
  connect(destination: ToneDestination): void {
    this.connected.push(destination);
  }
  start(at: number): void {
    this.started = at;
  }
  stop(at: number): void {
    this.stopped = at;
  }
}

type Failure = "none" | "oscillator" | "resume-rejects";

class FakeContext implements ToneContext {
  readonly destination = { name: "speakers" };
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  resumes = 0;

  constructor(
    public state: string,
    readonly currentTime: number,
    private readonly failure: Failure = "none",
  ) {}

  createOscillator(): FakeOscillator {
    if (this.failure === "oscillator") throw new Error("NotSupportedError");
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  resume(): Promise<void> {
    this.resumes += 1;
    if (this.failure === "resume-rejects") return Promise.reject(new Error("NotAllowedError"));
    return Promise.resolve();
  }
}

const beep: Tone = { frequencyHz: 880, durationMs: 70, volume: 0.12 };

/** Lets rejected promises settle, so an unhandled rejection would fail the test run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createToneSynth", () => {
  it("正弦波1本を、立ち上がり5msで音量まで上げ、長さの終わりまでに消えるよう減衰させる", () => {
    const context = new FakeContext("running", 10);
    createToneSynth(() => context)(beep);
    const [oscillator] = context.oscillators;
    const [gain] = context.gains;
    expect(oscillator?.type).toBe("sine");
    expect(oscillator?.frequency.calls).toEqual([["set", 880, 10]]);
    expect(gain?.gain.calls).toEqual([
      ["set", 0, 10],
      ["linear", 0.12, 10 + TONE_ATTACK_S],
      ["exponential", 0.0001, 10.07],
    ]);
    expect(oscillator?.connected).toEqual([gain]);
    expect(gain?.connected).toEqual([context.destination]);
    expect(oscillator?.started).toBe(10);
    expect(oscillator?.stopped).toBeCloseTo(10.08);
    expect(context.resumes).toBe(0);
  });

  it("AudioContext は最初の1音で1つだけ作り、以後は使い回す", () => {
    let made = 0;
    const context = new FakeContext("running", 0);
    const play = createToneSynth(() => {
      made += 1;
      return context;
    });
    expect(made).toBe(0);
    play(beep);
    play(beep);
    expect(made).toBe(1);
    expect(context.oscillators).toHaveLength(2);
  });

  it("止まっている（suspended）なら resume を頼んでから鳴らし、拒否されても例外を残さない", async () => {
    const context = new FakeContext("suspended", 0, "resume-rejects");
    expect(() => {
      createToneSynth(() => context)(beep);
    }).not.toThrow();
    await settle();
    expect(context.resumes).toBe(1);
    expect(context.oscillators).toHaveLength(1);
  });

  it("AudioContext が無い環境では黙って鳴らさない", () => {
    let asked = 0;
    const play = createToneSynth(() => {
      asked += 1;
      return null;
    });
    expect(() => {
      play(beep);
      play(beep);
    }).not.toThrow();
    expect(asked).toBe(1);
  });

  it("AudioContext を作れなくても例外を外へ出さず、作り直しも試みない", () => {
    let asked = 0;
    const play = createToneSynth(() => {
      asked += 1;
      throw new Error("NotSupportedError");
    });
    expect(() => {
      play(beep);
      play(beep);
    }).not.toThrow();
    expect(asked).toBe(1);
  });

  it("音の部品を作れなくても例外を外へ出さない", () => {
    const context = new FakeContext("running", 0, "oscillator");
    expect(() => {
      createToneSynth(() => context)(beep);
    }).not.toThrow();
  });

  it("既定（ブラウザの AudioContext）が無い環境でも例外を出さない", () => {
    expect(() => {
      createToneSynth()(beep);
    }).not.toThrow();
  });
});
