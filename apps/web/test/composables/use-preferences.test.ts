import { describe, expect, it } from "vitest";

import {
  FONT_STEP_KEY,
  SFX_MUTED_KEY,
  toFontStep,
  usePreferences,
} from "../../src/composables/use-preferences.js";
import type { KeyValueStorage } from "../../src/ports.js";

class FakeStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  readonly writes: [string, string][] = [];
  failReads = false;
  failWrites = false;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [key, value] of Object.entries(initial)) this.items.set(key, value);
  }

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("SecurityError");
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.writes.push([key, value]);
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe("usePreferences", () => {
  it("何も保存されていなければ、音あり・標準の文字サイズで始まる", () => {
    const prefs = usePreferences(new FakeStorage());
    expect(prefs.muted.value).toBe(false);
    expect(prefs.fontStep.value).toBe(1);
    expect(prefs.canShrinkFont.value).toBe(false);
    expect(prefs.canEnlargeFont.value).toBe(true);
  });

  it("モックと同じキーから、保存済みのミュートと文字サイズを読み戻す", () => {
    const prefs = usePreferences(new FakeStorage({ [SFX_MUTED_KEY]: "1", [FONT_STEP_KEY]: "3" }));
    expect(prefs.muted.value).toBe(true);
    expect(prefs.fontStep.value).toBe(3);
    expect(prefs.canEnlargeFont.value).toBe(false);
    expect(prefs.canShrinkFont.value).toBe(true);
  });

  it('ミュートは "1" だけを消音と読む', () => {
    for (const stored of ["0", "true", "", "01"]) {
      expect(usePreferences(new FakeStorage({ [SFX_MUTED_KEY]: stored })).muted.value).toBe(false);
    }
  });

  it('ミュートを切り替えるたびに "1" / "0" で保存する', () => {
    const storage = new FakeStorage();
    const prefs = usePreferences(storage);
    prefs.toggleMute();
    expect(prefs.muted.value).toBe(true);
    prefs.toggleMute();
    expect(prefs.muted.value).toBe(false);
    expect(storage.writes).toEqual([
      [SFX_MUTED_KEY, "1"],
      [SFX_MUTED_KEY, "0"],
    ]);
  });

  it("文字サイズは 1〜3 の間で上げ下げし、端では止まる", () => {
    const storage = new FakeStorage();
    const prefs = usePreferences(storage);
    prefs.shrinkFont();
    expect(prefs.fontStep.value).toBe(1);
    prefs.enlargeFont();
    prefs.enlargeFont();
    prefs.enlargeFont();
    expect(prefs.fontStep.value).toBe(3);
    prefs.shrinkFont();
    expect(prefs.fontStep.value).toBe(2);
    expect(storage.items.get(FONT_STEP_KEY)).toBe("2");
  });

  it.each([
    ["0", 1],
    ["-2", 1],
    ["2", 2],
    ["2.9", 2],
    ["4", 3],
    ["abc", 1],
    ["", 1],
  ] as const)("保存値 %j は段階 %i として読む", (stored, expected) => {
    expect(usePreferences(new FakeStorage({ [FONT_STEP_KEY]: stored })).fontStep.value).toBe(
      expected,
    );
  });

  it("Storage の読み出しが例外を投げても既定値で始まる", () => {
    const storage = new FakeStorage({ [SFX_MUTED_KEY]: "1", [FONT_STEP_KEY]: "3" });
    storage.failReads = true;
    const prefs = usePreferences(storage);
    expect(prefs.muted.value).toBe(false);
    expect(prefs.fontStep.value).toBe(1);
  });

  it("Storage の書き込みが例外を投げても、この画面では設定が効く", () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const prefs = usePreferences(storage);
    expect(() => {
      prefs.toggleMute();
      prefs.enlargeFont();
    }).not.toThrow();
    expect(prefs.muted.value).toBe(true);
    expect(prefs.fontStep.value).toBe(2);
    expect(storage.items.size).toBe(0);
  });
});

describe("toFontStep", () => {
  it.each([
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 3],
    [Number.NEGATIVE_INFINITY, 1],
    [1, 1],
    [2, 2],
    [3, 3],
  ] as const)("%s → %i", (value, expected) => {
    expect(toFontStep(value)).toBe(expected);
  });
});
