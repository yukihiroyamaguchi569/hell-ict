import { describe, expect, it } from "vitest";

import * as content from "../src/index.js";
import { systemPrompts } from "../src/prompts.js";
import { stage3Rules, stage4Rules, stage6Rules } from "../src/rules.js";
import { scenarioId } from "../src/scenario.js";
import {
  stage3RulesSchema,
  stage4RulesSchema,
  stage6RulesSchema,
  systemPromptsSchema,
} from "../src/schemas.js";

describe("シナリオの境界", () => {
  it("判定の語と system prompt が schema を満たす", () => {
    expect(stage3RulesSchema.safeParse(stage3Rules).success).toBe(true);
    expect(stage4RulesSchema.safeParse(stage4Rules).success).toBe(true);
    expect(stage6RulesSchema.safeParse(stage6Rules).success).toBe(true);
    expect(systemPromptsSchema.safeParse(systemPrompts).success).toBe(true);
  });

  it("scenarioId は空でない文字列", () => {
    expect(scenarioId).toMatch(/\S/);
  });

  it("system prompt は index から export されない（web のバンドルに入れない）", () => {
    expect(Object.values(content)).not.toContain(systemPrompts);
    expect(Object.keys(content)).not.toContain("systemPrompts");
  });
});

describe("stage3RulesSchema", () => {
  it.each([
    ["欄が欠けている", { ...stage3Rules, required: { ppe: [/a/], release: [/a/] } }],
    ["語が正規表現でない", { ...stage3Rules, fabricatedSource: "出典" }],
    ["語が g フラグを持つ", { ...stage3Rules, fabricatedSource: /出典/g }],
    ["語が y フラグを持つ", { ...stage3Rules, fabricatedSource: /出典/y }],
    ["必須の語が空", { ...stage3Rules, required: { ...stage3Rules.required, clean: [] } }],
    [
      "罠に unless が無い",
      { ...stage3Rules, traps: { ...stage3Rules.traps, ppe: { words: /a/ } } },
    ],
  ])("%sものを拒否する", (_label, value) => {
    expect(stage3RulesSchema.safeParse(value).success).toBe(false);
  });
});

describe("stage6RulesSchema", () => {
  it("候補の種類に無いタグを拒否する", () => {
    const value = { ...stage6Rules, posterTags: [{ type: "photo", tag: /写真/ }] };
    expect(stage6RulesSchema.safeParse(value).success).toBe(false);
  });
});

describe("systemPromptsSchema", () => {
  it("プロファイルが欠けたもの・空のものを拒否する", () => {
    expect(systemPromptsSchema.safeParse({ default: "a", s1: "b" }).success).toBe(false);
    expect(systemPromptsSchema.safeParse({ ...systemPrompts, s3: "" }).success).toBe(false);
  });
});
