import { describe, expect, it } from "vitest";

import { parseOpenAiChatCompletion } from "../../src/schemas/openai-response.js";

describe("OpenAI Chat Completions応答schema", () => {
  it("choicesとusageを検証して受理する", () => {
    const response = {
      choices: [{ message: { content: "了解しました" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    expect(parseOpenAiChatCompletion(response)).toEqual(response);
  });

  it("usage無しでも受理する", () => {
    const response = { choices: [{ message: { content: "了解しました" } }] };
    expect(parseOpenAiChatCompletion(response)).toEqual(response);
  });

  it("ポリシー拒否（content: null, refusal）を受理する", () => {
    const response = { choices: [{ message: { content: null, refusal: "対応できません" } }] };
    expect(parseOpenAiChatCompletion(response)).toEqual(response);
  });

  it("refusal無しのcontent: nullも受理する（原因不明の拒否として扱う）", () => {
    const response = { choices: [{ message: { content: null } }] };
    expect(parseOpenAiChatCompletion(response)).toEqual(response);
  });

  it("choicesが空、contentが空文字、配列を拒否する", () => {
    for (const input of [
      { choices: [] },
      { choices: [{ message: { content: "" } }] },
      { choices: [{ message: { content: null, refusal: "" } }] },
      null,
      [],
      {},
    ]) {
      expect(() => parseOpenAiChatCompletion(input)).toThrow();
    }
  });
});
