import { describe, expect, it } from "vitest";

import {
  parseOpenAiChatCompletion,
  parseOpenAiErrorBody,
} from "../../src/schemas/openai-response.js";

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

describe("OpenAIエラー応答schema", () => {
  it("insufficient_quotaのcodeとtypeを取り出し、messageは返さない", () => {
    const parsed = parseOpenAiErrorBody({
      error: {
        message: "You exceeded your current quota, sk-secret",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    });
    expect(parsed).toEqual({ code: "insufficient_quota", type: "insufficient_quota" });
    expect(JSON.stringify(parsed)).not.toContain("sk-secret");
  });

  it("code: nullはnullとして扱い、typeだけを残す", () => {
    expect(parseOpenAiErrorBody({ error: { code: null, type: "server_error" } })).toEqual({
      code: null,
      type: "server_error",
    });
  });

  it("許可文字の外や65文字以上の値はその項目だけを落とす", () => {
    expect(
      parseOpenAiErrorBody({ error: { code: "山田 花子", type: "rate_limit_exceeded" } }),
    ).toEqual({ code: null, type: "rate_limit_exceeded" });
    expect(parseOpenAiErrorBody({ error: { code: "a".repeat(65), type: 42 } })).toEqual({
      code: null,
      type: null,
    });
    expect(parseOpenAiErrorBody({ error: { code: "a".repeat(64) } })).toEqual({
      code: "a".repeat(64),
      type: null,
    });
  });

  it("APIキーの形・大文字・記号・数字始まりの値は識別子として受け付けない", () => {
    for (const value of ["sk-proj-abc123", "Insufficient_Quota", "rate-limit", "a.b", "1abc", ""]) {
      expect(parseOpenAiErrorBody({ error: { code: value, type: value } }), value).toEqual({
        code: null,
        type: null,
      });
    }
  });

  it("エラー応答の形でない入力は両方nullにする", () => {
    for (const input of [null, "rate limited", [], { error: "quota" }, { detail: "x" }]) {
      expect(parseOpenAiErrorBody(input)).toEqual({ code: null, type: null });
    }
  });
});
