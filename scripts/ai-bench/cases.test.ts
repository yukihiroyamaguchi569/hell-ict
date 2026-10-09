import { describe, expect, it } from "vitest";

import { buildCases, parseSystemPrompts } from "./build-cases.ts";
import { estimateCaseTokens, estimateTokens, parseCases } from "./cases.ts";

const valid = {
  id: "s1-draft",
  stage: "s1",
  label: "draft a reply",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second" },
  ],
};

describe("parseCases", () => {
  it("accepts a valid case file", () => {
    expect(parseCases([valid])).toEqual([valid]);
  });

  it("drops fields it does not know", () => {
    expect(parseCases([{ ...valid, extra: 1 }])[0]).not.toHaveProperty("extra");
  });

  it.each([
    [[], "non-empty array"],
    [{}, "non-empty array"],
    [[null], "must be an object"],
    [[{ ...valid, id: "" }], '"id" must be a non-empty string'],
    [[{ ...valid, label: 3 }], '"label" must be a non-empty string'],
    [[{ ...valid, messages: [] }], '"messages" must be a non-empty array'],
    [[{ ...valid, messages: [{ role: "tool", content: "x" }] }], '"role" must be one of'],
    [[{ ...valid, messages: [{ role: "user", content: "" }] }], '"content" must be'],
    [[{ ...valid, messages: [{ role: "user" }] }], '"content" must be'],
    [
      [
        {
          ...valid,
          messages: [
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
          ],
        },
      ],
      "last message must be from the user",
    ],
    [[valid, valid], 'duplicate id "s1-draft"'],
  ])("rejects %j", (input, message) => {
    expect(() => parseCases(input)).toThrow(message);
  });
});

describe("estimateTokens", () => {
  it("counts about one token per Japanese character and one per four ASCII characters", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("あいう")).toBe(3);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("😀")).toBe(1);
  });

  it("adds a little per message", () => {
    const [parsed] = parseCases([valid]);
    expect(parsed && estimateCaseTokens(parsed)).toBe(1 + 2 + 2 + 2 + 16);
  });
});

describe("parseSystemPrompts", () => {
  it("reads the systemPrompts export", () => {
    const prompts = parseSystemPrompts({ systemPrompts: { default: "d", s1: "one" } });
    expect([...prompts]).toEqual([
      ["default", "d"],
      ["s1", "one"],
    ]);
  });

  it.each([
    [{}],
    [{ systemPrompts: "x" }],
    [{ systemPrompts: { s1: "" } }],
    [{ systemPrompts: { s1: 1 } }],
  ])("rejects %j", (exports) => {
    expect(() => parseSystemPrompts(exports)).toThrow();
  });
});

describe("buildCases", () => {
  const prompts = new Map([
    ["default", "DEFAULT PROMPT"],
    ["s3", "S3 PROMPT"],
  ]);
  const pick = {
    id: "s3-q",
    stage: "s3",
    label: "question",
    promptProfile: "s3",
    messages: [{ role: "user", content: "q" }],
  };

  it("puts the profile's system prompt in front, as the Worker does", () => {
    expect(buildCases([pick], prompts)).toEqual([
      {
        id: "s3-q",
        stage: "s3",
        label: "question",
        messages: [
          { role: "system", content: "S3 PROMPT" },
          { role: "user", content: "q" },
        ],
      },
    ]);
  });

  it('uses "default" when the pick names no profile', () => {
    const [built] = buildCases([{ ...pick, promptProfile: undefined }], prompts);
    expect(built?.messages[0]).toEqual({ role: "system", content: "DEFAULT PROMPT" });
  });

  it.each([
    ["not an array", { ...pick }, "picks: must be an array"],
    ["an unknown profile", [{ ...pick, promptProfile: "s9" }], 'no system prompt for "s9"'],
    ["a non-string profile", [{ ...pick, promptProfile: 3 }], '"promptProfile" must be a string'],
    ["no messages", [{ ...pick, messages: undefined }], '"messages" missing'],
    [
      "a system message of its own",
      [{ ...pick, messages: [{ role: "system", content: "x" }, ...pick.messages] }],
      "the system prompt is added here",
    ],
    ["a missing id", [{ ...pick, id: undefined }], '"id" must be a non-empty string'],
  ])("rejects %s", (_name, picks, message) => {
    expect(() => buildCases(picks, prompts)).toThrow(message);
  });
});
