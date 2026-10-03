import { onScopeDispose, watch, type Ref } from "vue";

import type { AudioPort, PreloadResult } from "../ports.js";

/*
 * Sound effects (mock `sfx()` / `applySfxMute`, hell-ict-scenario:docs/ui/00_共通シェルと通奏低音.md §11).
 * The mute button is the venue's switch to silence the room, not a way to pick and play sounds:
 * 効果音ラボ's terms forbid a sound-test screen, so nothing here plays a sound on request of the
 * participants. The mp3s are not in the repository; the Worker serves them from R2 at
 * /sounds/<name>.mp3, and a missing file only means silence.
 */

/** The seven sounds the Worker serves (apps/worker/src/sounds.ts). */
export const SFX_NAMES = [
  "emergency-alert1",
  "mobile-phone-ringtone1",
  "decision1",
  "don-1",
  "cancel",
  "success1",
  "hall-clapping-hands1",
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

const DEFAULT_VOLUME = 0.4;

/** Mail landings are quieter: Stage 1 lands five in a row, and the chime must not take over. */
const VOLUMES: Readonly<Partial<Record<SfxName, number>>> = { decision1: 0.25 };

export const sfxVolume = (name: SfxName, volume?: number): number =>
  volume ?? VOLUMES[name] ?? DEFAULT_VOLUME;

export interface Sfx {
  /**
   * `volume` only when the same sound is borrowed for another use (the bottle refill of the
   * Stage 3 penalty). 0 means silent, not the default.
   */
  readonly play: (name: SfxName, volume?: number) => void;
}

/**
 * Browsers block sound until the page has had a user gesture, so nothing plays before the first
 * click on `gestureTarget` (caught in the capture phase: the click that unlocks may itself play).
 */
export const useSfx = (
  audio: AudioPort,
  muted: Readonly<Ref<boolean>>,
  gestureTarget: EventTarget,
): Sfx => {
  let unlocked = false;
  const unlock = (): void => {
    unlocked = true;
  };
  gestureTarget.addEventListener("click", unlock, { once: true, capture: true });
  // Unmounted before the first click: do not leave the listener on the page.
  onScopeDispose(() => {
    gestureTarget.removeEventListener("click", unlock, { capture: true });
  });

  watch(muted, (isMuted) => {
    if (isMuted) audio.stopAll();
  });

  return {
    play: (name, volume) => {
      if (!unlocked || muted.value) return;
      audio.play(name, sfxVolume(name, volume));
    },
  };
};

/** The part of HTMLAudioElement the browser AudioPort uses (a Fake in tests). */
export interface SfxElement {
  volume: number;
  currentTime: number;
  preload: string;
  readonly readyState: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(
    type: "error" | "canplaythrough",
    listener: () => void,
    options: { once: boolean },
  ): void;
}

/** HTMLMediaElement.HAVE_ENOUGH_DATA: the sound can play through without waiting. */
const HAVE_ENOUGH_DATA = 4;

/**
 * The browser's AudioPort: one <audio> per sound, rewound and replayed for back-to-back
 * landings (layering the same wave clips). Every failure is swallowed, thrown or rejected:
 * creating the element, setting the volume, seeking, playing (missing file, autoplay policy)
 * and pausing. A sound must never stop the game. `preload` builds the same element the play
 * uses, so a sound loaded by the opening (Issue #379) is played from it without a second fetch.
 * An element that failed to load is dropped, so the next play or preload fetches it again.
 */
export const createBrowserSfxAudio = (
  createElement: (src: string) => SfxElement = (src) => new Audio(src),
): AudioPort => {
  const cache = new Map<string, SfxElement>();

  const element = (name: string): SfxElement => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const created = createElement(`/sounds/${name}.mp3`);
    created.preload = "auto";
    created.addEventListener(
      "error",
      () => {
        if (cache.get(name) === created) cache.delete(name);
      },
      { once: true },
    );
    cache.set(name, created);
    return created;
  };

  const preload = (name: string): Promise<PreloadResult> =>
    new Promise((resolve) => {
      try {
        const audio = element(name);
        if (audio.readyState >= HAVE_ENOUGH_DATA) {
          resolve("loaded");
          return;
        }
        audio.addEventListener(
          "canplaythrough",
          () => {
            resolve("loaded");
          },
          { once: true },
        );
        audio.addEventListener(
          "error",
          () => {
            resolve("failed");
          },
          { once: true },
        );
      } catch {
        resolve("failed");
      }
    });

  const rewind = (audio: SfxElement): void => {
    try {
      audio.currentTime = 0;
    } catch {
      // Seeking before the file has loaded may throw; playing from the start is the same.
    }
  };

  return {
    play: (name, volume) => {
      try {
        const audio = element(name);
        audio.volume = volume;
        rewind(audio);
        audio.play().catch(() => undefined);
      } catch {
        // No sound this time; the game goes on.
      }
    },
    stopAll: () => {
      for (const audio of cache.values()) {
        try {
          audio.pause();
        } catch {
          // Keep stopping the others.
        }
      }
    },
    preload,
  };
};
