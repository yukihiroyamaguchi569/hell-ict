import { computed, readonly, ref, type ComputedRef, type Ref } from "vue";

import type { KeyValueStorage } from "../ports.js";

/** Same keys as the mock, so a PC that ran the mock keeps its settings. */
export const SFX_MUTED_KEY = "hellSfxMuted";
export const FONT_STEP_KEY = "hellFontStep";

/** 標準／大／特大 (mock FS_MAX). The scale itself lives in CSS (--fs-scale by data-fs). */
export const FONT_STEPS = [1, 2, 3] as const;
export type FontStep = (typeof FONT_STEPS)[number];

const MIN_FONT_STEP: FontStep = 1;
const MAX_FONT_STEP: FontStep = 3;

/** Any stored or requested value to a valid step: out of range clamps, garbage is 標準. */
export const toFontStep = (value: number): FontStep => {
  const step = Math.trunc(value);
  if (step >= MAX_FONT_STEP) return MAX_FONT_STEP;
  if (step === 2) return 2;
  return MIN_FONT_STEP;
};

/*
 * Every storage call may throw (private mode, blocked site data), and a failing storage must
 * never stop the game: a preference is a convenience.
 */
const readItem = (storage: KeyValueStorage, key: string): string | null => {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

const writeItem = (storage: KeyValueStorage, key: string, value: string): void => {
  try {
    storage.setItem(key, value);
  } catch {
    // Not saved: the setting still holds for this page.
  }
};

export interface Preferences {
  readonly muted: Readonly<Ref<boolean>>;
  readonly fontStep: Readonly<Ref<FontStep>>;
  readonly canShrinkFont: ComputedRef<boolean>;
  readonly canEnlargeFont: ComputedRef<boolean>;
  readonly toggleMute: () => void;
  readonly shrinkFont: () => void;
  readonly enlargeFont: () => void;
}

/** The venue's two switches in the header: sound effects off, and the text size. */
export const usePreferences = (storage: KeyValueStorage): Preferences => {
  const muted = ref(readItem(storage, SFX_MUTED_KEY) === "1");
  // Number(null) is 0 and Number("x") is NaN: both fall back to 標準.
  const fontStep = ref<FontStep>(toFontStep(Number(readItem(storage, FONT_STEP_KEY))));

  const setFontStep = (value: number): void => {
    fontStep.value = toFontStep(value);
    writeItem(storage, FONT_STEP_KEY, String(fontStep.value));
  };

  return {
    muted: readonly(muted),
    fontStep: readonly(fontStep),
    canShrinkFont: computed(() => fontStep.value > MIN_FONT_STEP),
    canEnlargeFont: computed(() => fontStep.value < MAX_FONT_STEP),
    toggleMute: () => {
      muted.value = !muted.value;
      writeItem(storage, SFX_MUTED_KEY, muted.value ? "1" : "0");
    },
    shrinkFont: () => {
      setFontStep(fontStep.value - 1);
    },
    enlargeFont: () => {
      setFontStep(fontStep.value + 1);
    },
  };
};
