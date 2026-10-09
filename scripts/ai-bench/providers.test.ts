import { describe, expect, it } from "vitest";

import { baseUrlOf, parseProviderName, PROVIDERS, readEndpoints } from "./providers.ts";

describe("PROVIDERS", () => {
  it("points each provider at its OpenAI-compatible endpoint and its own key variable", () => {
    expect(
      Object.values(PROVIDERS).map(({ name, baseUrl, keyEnv }) => [name, baseUrl, keyEnv]),
    ).toEqual([
      ["openai", "https://api.openai.com/v1", "OPENAI_API_KEY"],
      ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"],
      ["anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"],
    ]);
  });

  it("reads no rate-limit header for Gemini, which documents none", () => {
    expect(PROVIDERS.gemini).toMatchObject({
      rateLimitHeaders: [],
      remainingRequestsHeader: null,
      remainingTokensHeader: null,
    });
  });
});

describe("parseProviderName", () => {
  it("accepts the three names, trimmed", () => {
    expect(parseProviderName(" anthropic ")).toBe("anthropic");
    expect(parseProviderName("gemini")).toBe("gemini");
  });

  it.each([["google"], ["Gemini"], [""], ["constructor"]])("rejects %j", (raw) => {
    expect(() => parseProviderName(raw)).toThrow(/--provider must be one of/);
  });
});

describe("baseUrlOf", () => {
  it("defaults to the provider and drops trailing slashes from an override", () => {
    expect(baseUrlOf({}, "openai")).toBe("https://api.openai.com/v1");
    expect(baseUrlOf({ OPENAI_BASE_URL: " " }, "openai")).toBe("https://api.openai.com/v1");
    expect(baseUrlOf({ OPENAI_BASE_URL: "http://localhost:9/v1//" }, "openai")).toBe(
      "http://localhost:9/v1",
    );
    expect(baseUrlOf({ GEMINI_BASE_URL: "http://localhost:8/g/" }, "gemini")).toBe(
      "http://localhost:8/g",
    );
  });

  it("accepts the provider's own host over https and a local stub over http", () => {
    expect(
      baseUrlOf(
        { GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/" },
        "gemini",
      ),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(baseUrlOf({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/v1" }, "anthropic")).toBe(
      "http://127.0.0.1:8787/v1",
    );
    expect(baseUrlOf({ OPENAI_BASE_URL: "http://[::1]:9/v1" }, "openai")).toBe("http://[::1]:9/v1");
  });

  it.each([
    ["OPENAI_BASE_URL", "openai", "https://evil.example/v1"],
    ["OPENAI_BASE_URL", "openai", "http://api.openai.com/v1"],
    ["OPENAI_BASE_URL", "openai", "https://api.anthropic.com/v1"],
    ["GEMINI_BASE_URL", "gemini", "https://generativelanguage.googleapis.com.evil.example/v1"],
    ["GEMINI_BASE_URL", "gemini", "https://user@evil.example/v1"],
    ["ANTHROPIC_BASE_URL", "anthropic", "https://localhost/v1"],
    ["ANTHROPIC_BASE_URL", "anthropic", "http://localhost.evil.example/v1"],
    ["ANTHROPIC_BASE_URL", "anthropic", "http://10.0.0.1/v1"],
    ["ANTHROPIC_BASE_URL", "anthropic", "not a url"],
  ] as const)("refuses %s=%s %s before any call", (name, provider, url) => {
    expect(() => baseUrlOf({ [name]: url }, provider)).toThrow(
      new RegExp(`${name} must point to `),
    );
  });

  it("stops in readEndpoints on a foreign override, without the key in the message", () => {
    let message = "";
    try {
      readEndpoints(
        { GEMINI_API_KEY: "AIza-secret-key", GEMINI_BASE_URL: "https://evil.example/v1" },
        ["gemini"],
      );
    } catch (caught) {
      message = caught instanceof Error ? caught.message : "";
    }
    expect(message).toContain("GEMINI_BASE_URL must point to");
    expect(message).not.toContain("AIza-secret-key");
  });

  it("does not take one provider's override for another", () => {
    expect(baseUrlOf({ OPENAI_BASE_URL: "http://localhost:9/v1" }, "anthropic")).toBe(
      "https://api.anthropic.com/v1",
    );
  });
});

describe("readEndpoints", () => {
  const env = {
    OPENAI_API_KEY: " sk-openai \n",
    GEMINI_API_KEY: "AIza-gemini",
    ANTHROPIC_API_KEY: "sk-ant-x",
  };

  it("reads the trimmed key and the endpoint of each provider in use, once each", () => {
    const endpoints = readEndpoints(env, ["gemini", "openai", "gemini"]);
    expect([...endpoints.entries()]).toEqual([
      [
        "gemini",
        {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          apiKey: "AIza-gemini",
        },
      ],
      ["openai", { baseUrl: "https://api.openai.com/v1", apiKey: "sk-openai" }],
    ]);
  });

  it("asks only for the keys of the providers in use", () => {
    expect(readEndpoints({ ANTHROPIC_API_KEY: "sk-ant-x" }, ["anthropic"]).size).toBe(1);
  });

  it.each([[undefined], [""], ["  "]])(
    "stops with a clear error when a key is missing (%j)",
    (geminiKey) => {
      expect(() =>
        readEndpoints({ ...env, GEMINI_API_KEY: geminiKey }, ["openai", "gemini"]),
      ).toThrow(
        "GEMINI_API_KEY is not set. Run `read -s GEMINI_API_KEY; export GEMINI_API_KEY` first",
      );
    },
  );

  it("names every missing key at once and never the value of a key that is set", () => {
    let message = "";
    try {
      readEndpoints({ OPENAI_API_KEY: "sk-openai-secret" }, ["openai", "gemini", "anthropic"]);
    } catch (caught) {
      message = caught instanceof Error ? caught.message : "";
    }
    expect(message).toContain("GEMINI_API_KEY, ANTHROPIC_API_KEY are not set");
    expect(message).not.toContain("sk-openai-secret");
    expect(message).not.toContain("OPENAI_API_KEY");
  });

  it("needs nothing for no providers", () => {
    expect(readEndpoints({}, []).size).toBe(0);
  });
});
