import type { Tone } from "../ports.js";

/*
 * Synthesized beeps (Web Audio). No sound file: one sine oscillator through a gain that rises in
 * a few milliseconds and decays away, so the beep starts and ends without a click.
 */

/** The parts of AudioParam a tone's envelope uses. */
export interface ToneParam {
  setValueAtTime(value: number, at: number): unknown;
  linearRampToValueAtTime(value: number, at: number): unknown;
  exponentialRampToValueAtTime(value: number, at: number): unknown;
}

export interface ToneNode {
  connect(destination: ToneDestination): unknown;
}

export type ToneDestination = object;

export interface ToneGain extends ToneNode {
  readonly gain: ToneParam;
}

export interface ToneOscillator extends ToneNode {
  type: OscillatorType;
  readonly frequency: ToneParam;
  start(at: number): void;
  stop(at: number): void;
}

/** The part of AudioContext the synth uses (a Fake in tests). */
export interface ToneContext {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: ToneDestination;
  createOscillator(): ToneOscillator;
  createGain(): ToneGain;
  resume(): Promise<void>;
}

/** The fade in: short enough to sound instant, long enough not to click. */
export const TONE_ATTACK_S = 0.005;
/** An exponential ramp cannot reach 0: it ends here, below hearing. */
const SILENT_GAIN = 0.0001;

/** The browser's AudioContext, or `null` where there is none. */
const browserContext = (): ToneContext | null =>
  typeof AudioContext === "function" ? new AudioContext() : null;

const scheduleTone = (context: ToneContext, tone: Tone): void => {
  const start = context.currentTime;
  const end = start + tone.durationMs / 1000;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(tone.frequencyHz, start);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(tone.volume, start + TONE_ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, end);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(end + 0.01);
};

/**
 * Plays tones on one AudioContext, made at the first tone (after the user's first click, when
 * the browser allows sound). Every failure is swallowed: no AudioContext, one that cannot be
 * made, or one that refuses to resume only means silence. A context that could not be made is
 * not asked for again.
 */
export const createToneSynth = (
  createContext: () => ToneContext | null = browserContext,
): ((tone: Tone) => void) => {
  let context: ToneContext | null | undefined;
  const ensureContext = (): ToneContext | null => {
    if (context === undefined) {
      try {
        context = createContext();
      } catch {
        context = null;
      }
    }
    return context;
  };
  return (tone) => {
    try {
      const current = ensureContext();
      if (current === null) return;
      if (current.state === "suspended") current.resume().catch(() => undefined);
      scheduleTone(current, tone);
    } catch {
      // No beep this time; the game goes on.
    }
  };
};
