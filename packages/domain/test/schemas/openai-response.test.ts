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

  it("choicesが空、contentが空文字、null、配列を拒否する", () => {
    for (const input of [
      { choices: [] },
      { choices: [{ message: { content: "" } }] },
      null,
      [],
      {},
    ]) {
      expect(() => parseOpenAiChatCompletion(input)).toThrow();
    }
  });
});
