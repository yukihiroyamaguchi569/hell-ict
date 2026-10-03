import { describe, expect, it } from "vitest";

import { isImeComposing } from "../src/ime-composing.js";

describe("isImeComposing", () => {
  it("treats a key flagged isComposing as part of a conversion", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("treats keyCode 229 as part of a conversion even when isComposing is false (Safari)", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("lets a plain Enter through", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it("does not mistake a neighbouring keyCode for 229", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 228 })).toBe(false);
    expect(isImeComposing({ isComposing: false, keyCode: 230 })).toBe(false);
  });
});
