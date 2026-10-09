import { describe, expect, it, vi } from "vitest";

import { modelSpecFor } from "./config.ts";
import { PROVIDERS } from "./providers.ts";
import {
  callModel,
  describeErrorBody,
  parseCompletion,
  readRateLimitHeaders,
  redactSecrets,
  requestBody,
} from "./openai.ts";
import type { CallDeps, FetchFn } from "./openai.ts";

const KEY = "sk-test-SECRET123";

const completion = (content: unknown, usage: unknown = undefined) => ({
  choices: [{ message: { role: "assistant", content } }],
  ...(usage === undefined ? {} : { usage }),
});

/** A clock that advances by `stepMs` each time it is read. */
const steppingClock = (stepMs: number) => {
  let now = 0;
  return {
    now: () => {
      const value = now;
      now += stepMs;
      return value;
    },
  };
};

const deps = (fetch: FetchFn, stepMs = 1500): CallDeps => ({ fetch, clock: steppingClock(stepMs) });

const request = (model = "gpt-4o", timeoutMs = 60_000) => ({
  baseUrl: "https://api.example.test/v1",
  apiKey: KEY,
  model: modelSpecFor(model),
  messages: [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "質問" },
  ],
  timeoutMs,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("readRateLimitHeaders", () => {
  it("reads the six rate-limit headers that are present and nothing else", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "500",
      "x-ratelimit-remaining-tokens": "29000",
      "x-ratelimit-reset-requests": "120ms",
      "x-request-id": "abc",
    });
    expect(readRateLimitHeaders(headers, PROVIDERS.openai.rateLimitHeaders)).toEqual({
      "x-ratelimit-limit-requests": "500",
      "x-ratelimit-remaining-tokens": "29000",
      "x-ratelimit-reset-requests": "120ms",
    });
  });

  it("returns an empty object when none are present", () => {
    expect(readRateLimitHeaders(new Headers(), PROVIDERS.openai.rateLimitHeaders)).toEqual({});
    expect(
      readRateLimitHeaders(
        new Headers({ "x-ratelimit-remaining-requests": "1" }),
        PROVIDERS.gemini.rateLimitHeaders,
      ),
    ).toEqual({});
  });
});

describe("redactSecrets", () => {
  it("masks the key and anything shaped like an OpenAI key", () => {
    expect(redactSecrets(`key ${KEY} and sk-proj-ab**cd`, KEY)).toBe(
      "key [REDACTED] and [REDACTED]",
    );
  });

  it("masks Anthropic's and Google's key shapes too", () => {
    expect(redactSecrets("a sk-ant-api03-xyz_1 b AIzaSyAbc-123_x c", "")).toBe(
      "a [REDACTED] b [REDACTED] c",
    );
  });

  it("leaves other text alone, also with an empty key", () => {
    expect(redactSecrets("plain text", "")).toBe("plain text");
  });
});

describe("parseCompletion", () => {
  it("reads the text and the usage, with reasoning tokens", () => {
    const body = completion("こんにちは", {
      prompt_tokens: 10,
      completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    expect(parseCompletion(body)).toEqual({
      ok: true,
      text: "こんにちは",
      usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 2 },
    });
  });

  it("keeps the reply but leaves the usage unknown when it is missing", () => {
    expect(parseCompletion(completion("a"))).toEqual({ ok: true, text: "a", usage: null });
  });

  it.each([
    ["a count given as a string", { prompt_tokens: "10", completion_tokens: 5 }],
    ["a missing count", { prompt_tokens: 10 }],
    ["a negative count", { prompt_tokens: -1, completion_tokens: 5 }],
    ["a fractional count", { prompt_tokens: 1.5, completion_tokens: 5 }],
    [
      "a malformed reasoning count",
      {
        prompt_tokens: 1,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: "2" },
      },
    ],
    ["malformed details", { prompt_tokens: 1, completion_tokens: 5, completion_tokens_details: 3 }],
    ["usage that is not an object", "100"],
  ])("leaves the usage unknown, not 0, for %s", (_name, usage) => {
    expect(parseCompletion(completion("a", usage))).toEqual({ ok: true, text: "a", usage: null });
  });

  it("takes reasoning tokens as 0 when the details or the field are absent", () => {
    for (const details of [undefined, null, {}, { reasoning_tokens: null }]) {
      expect(
        parseCompletion(
          completion("a", {
            prompt_tokens: 0,
            completion_tokens: 2,
            completion_tokens_details: details,
          }),
        ),
      ).toEqual({
        ok: true,
        text: "a",
        usage: { promptTokens: 0, completionTokens: 2, reasoningTokens: 0 },
      });
    }
  });

  it("takes a total that adds up as it is", () => {
    expect(
      parseCompletion(
        completion("a", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      ),
    ).toMatchObject({ usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0 } });
    expect(
      parseCompletion(
        completion("a", { prompt_tokens: 1, completion_tokens: 2, total_tokens: null }),
      ),
    ).toMatchObject({ usage: { promptTokens: 1, completionTokens: 2, reasoningTokens: 0 } });
  });

  it("counts tokens the total has beyond prompt + completion as billed output (thinking)", () => {
    expect(
      parseCompletion(
        completion("a", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 40 }),
      ),
    ).toMatchObject({ usage: { promptTokens: 10, completionTokens: 30, reasoningTokens: 25 } });
  });

  it.each([
    [
      "a total smaller than its parts",
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 14 },
    ],
    ["a total given as a string", { prompt_tokens: 10, completion_tokens: 5, total_tokens: "15" }],
    ["Gemini's native field names", { promptTokenCount: 10, candidatesTokenCount: 5 }],
    ["Anthropic's native field names", { input_tokens: 10, output_tokens: 5 }],
  ])("leaves the usage unknown, not 0, for %s", (_name, usage) => {
    expect(parseCompletion(completion("a", usage))).toEqual({ ok: true, text: "a", usage: null });
  });

  it("accepts an empty reply", () => {
    expect(parseCompletion(completion(""))).toMatchObject({ ok: true, text: "" });
  });

  it.each([
    [null, "no choices in the response"],
    [{ choices: "x" }, "no choices in the response"],
    [{ choices: [] }, "no message in the first choice"],
    [{ choices: [{ message: { content: null, refusal: "no" } }] }, "refusal"],
    [{ choices: [{ message: { content: null } }] }, "no content in the message"],
  ])("rejects %j", (body, message) => {
    expect(parseCompletion(body)).toEqual({ ok: false, message });
  });
});

describe("describeErrorBody", () => {
  it("keeps the code and type but never the free-text message", () => {
    const body = {
      error: { message: `Incorrect API key ${KEY}`, code: "invalid_api_key", type: "x" },
    };
    expect(describeErrorBody(body)).toBe("invalid_api_key / x");
  });

  it("says so when there is no usable error body", () => {
    expect(describeErrorBody(undefined)).toBe("no error body");
    expect(describeErrorBody([])).toBe("no error body");
    expect(describeErrorBody({ error: { message: "m" } })).toBe("no error code");
    expect(describeErrorBody({ error: { code: Number.NaN, type: "" } })).toBe("no error code");
  });

  it("reads Gemini's numeric code and status, also wrapped in an array", () => {
    const gemini = { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } };
    expect(describeErrorBody(gemini)).toBe("429 / RESOURCE_EXHAUSTED");
    expect(describeErrorBody([gemini])).toBe("429 / RESOURCE_EXHAUSTED");
  });

  it("reads Anthropic's error type", () => {
    const body = { type: "error", error: { type: "rate_limit_error", message: "slow" } };
    expect(describeErrorBody(body)).toBe("rate_limit_error");
  });
});

describe("requestBody", () => {
  it("sends only model and messages for a model without parameters", () => {
    expect(JSON.parse(requestBody(modelSpecFor("gpt-4.1"), request().messages))).toEqual({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "質問" },
      ],
    });
  });

  it("adds reasoning_effort none for gpt-6-sol", () => {
    const body: unknown = JSON.parse(requestBody(modelSpecFor("gpt-6-sol"), []));
    expect(body).toEqual({ model: "gpt-6-sol", messages: [], reasoning_effort: "none" });
  });

  it("adds each other provider's way of keeping the reasoning down", () => {
    const bodyOf = (name: string): unknown => JSON.parse(requestBody(modelSpecFor(name), []));
    expect(bodyOf("gemini-3.8-flash")).toEqual({
      model: "gemini-3.8-flash",
      messages: [],
      reasoning_effort: "minimal",
    });
    expect(bodyOf("claude-haiku-5-5")).toEqual({
      model: "claude-haiku-5-5",
      messages: [],
      thinking: { type: "disabled" },
    });
    expect(bodyOf("claude-sonnet-5-5")).toMatchObject({ thinking: { type: "between_tools" } });
    expect(bodyOf("claude-haiku-4-5-20251001")).toEqual({
      model: "claude-haiku-4-5-20251001",
      messages: [],
    });
  });
});

describe("callModel", () => {
  it("posts to chat/completions with the key in the header and returns the reply", async () => {
    const fetch = vi.fn<FetchFn>(() =>
      Promise.resolve(
        jsonResponse(completion("回答", { prompt_tokens: 3, completion_tokens: 4 }), {
          headers: { "x-ratelimit-remaining-requests": "499" },
        }),
      ),
    );
    const result = await callModel(request(), deps(fetch));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(result).toEqual({
      status: 200,
      text: "回答",
      usage: { promptTokens: 3, completionTokens: 4, reasoningTokens: 0 },
      error: null,
      rateLimit: { "x-ratelimit-remaining-requests": "499" },
      elapsedMs: 1500,
    });
  });

  it("records an HTTP error with its status, code and the rate-limit headers", async () => {
    const fetch: FetchFn = () =>
      Promise.resolve(
        jsonResponse(
          { error: { message: "slow down", code: "rate_limit_exceeded", type: "requests" } },
          { status: 429, headers: { "x-ratelimit-remaining-requests": "0" } },
        ),
      );
    const result = await callModel(request(), deps(fetch));
    expect(result).toMatchObject({
      status: 429,
      text: null,
      usage: null,
      error: { kind: "http_error", message: "rate_limit_exceeded / requests" },
      rateLimit: { "x-ratelimit-remaining-requests": "0" },
    });
  });

  it("keeps the headers of the model's provider: Anthropic's own and the OpenAI-style ones", async () => {
    const fetch: FetchFn = () =>
      Promise.resolve(
        jsonResponse(completion("x", { prompt_tokens: 1, completion_tokens: 1 }), {
          headers: {
            "x-ratelimit-remaining-tokens": "9000",
            "anthropic-ratelimit-requests-remaining": "9999",
            "retry-after": "3",
            "request-id": "req_1",
          },
        }),
      );
    const result = await callModel(request("claude-haiku-4-5-20251001"), deps(fetch));
    expect(result.rateLimit).toEqual({
      "x-ratelimit-remaining-tokens": "9000",
      "anthropic-ratelimit-requests-remaining": "9999",
      "retry-after": "3",
    });
  });

  it("keeps no header for Gemini, which documents none, and still reads the reply", async () => {
    const fetch: FetchFn = () =>
      Promise.resolve(
        jsonResponse(completion("x", { prompt_tokens: 1, completion_tokens: 1 }), {
          headers: { "x-ratelimit-remaining-requests": "5" },
        }),
      );
    const result = await callModel(request("gemini-3.8-flash"), deps(fetch));
    expect(result).toMatchObject({ text: "x", rateLimit: {}, error: null });
  });

  it("records a Gemini 429 without the key the error quoted", async () => {
    const geminiKey = "AIzaSyTESTgeminiKEY";
    const fetch: FetchFn = () =>
      Promise.resolve(
        jsonResponse([{ error: { code: 429, message: `key ${geminiKey}`, status: geminiKey } }], {
          status: 429,
        }),
      );
    const result = await callModel(
      { ...request("gemini-3.8-flash"), apiKey: geminiKey },
      deps(fetch),
    );
    expect(result.error).toEqual({ kind: "http_error", message: "429 / [REDACTED]" });
    expect(JSON.stringify(result)).not.toContain(geminiKey);
  });

  it("records a 401 without the key, even when the body quotes it", async () => {
    const fetch: FetchFn = () =>
      Promise.resolve(
        jsonResponse({ error: { message: `bad ${KEY}`, code: KEY, type: null } }, { status: 401 }),
      );
    const result = await callModel(request(), deps(fetch));
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.error).toEqual({ kind: "http_error", message: "[REDACTED]" });
  });

  it("records a non-JSON error body as having no error body", async () => {
    const fetch: FetchFn = () =>
      Promise.resolve(new Response("<html>bad gateway</html>", { status: 502 }));
    const result = await callModel(request(), deps(fetch));
    expect(result.error).toEqual({ kind: "http_error", message: "no error body" });
  });

  it("records a 200 that is not JSON or has no content as invalid_response", async () => {
    const notJson: FetchFn = () => Promise.resolve(new Response("oops"));
    expect((await callModel(request(), deps(notJson))).error).toEqual({
      kind: "invalid_response",
      message: "body is not JSON",
    });
    const noContent: FetchFn = () => Promise.resolve(jsonResponse(completion(null)));
    expect((await callModel(request(), deps(noContent))).error?.kind).toBe("invalid_response");
  });

  it("records a lost connection as network", async () => {
    const fetch: FetchFn = () => Promise.reject(new TypeError("fetch failed"));
    const result = await callModel(request(), deps(fetch));
    expect(result).toMatchObject({ status: null, error: { kind: "network" } });
  });

  it("aborts the call after the timeout and records it as timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetch: FetchFn = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      const pending = callModel(request("gpt-4o", 5_000), deps(fetch));
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(result.error).toEqual({ kind: "timeout", message: "no reply within 5000 ms" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the status when the body read times out after the headers came", async () => {
    vi.useFakeTimers();
    try {
      const fetch: FetchFn = (_url, init) => {
        const body = new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      };
      const pending = callModel(request("gpt-4o", 1_000), deps(fetch));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ status: 200, error: { kind: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  });
});
