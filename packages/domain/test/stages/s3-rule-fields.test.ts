import { stage3Rules } from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import { STAGE3_FIELD_IDS } from "../../src/stages/s3.js";

// The words live in content; the judge walks STAGE3_FIELD_IDS. A field only one side knows
// would be silently skipped (or crash), so both must name exactly the same fields.
describe("Stage 3 の判定語と欄の対応", () => {
  it("必須の語と罠の語が、判定の欄をちょうど覆う", () => {
    const fields = [...STAGE3_FIELD_IDS].sort();
    expect(Object.keys(stage3Rules.required).sort()).toEqual(fields);
    expect(Object.keys(stage3Rules.traps).sort()).toEqual(fields);
  });
});
