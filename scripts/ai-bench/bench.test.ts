import { describe, expect, it } from "vitest";

import {
  costOf,
  callCost,
  isCutOffBeforeProductionTimeout,
  isOverProductionTimeout,
  median,
  planJobs,
  runJobs,
  summarize,
  summarizeModel,
} from "./bench.ts";
import type { JobResult } from "./bench.ts";
import type { BenchCase } from "./cases.ts";
import { modelSpecFor } from "./config.ts";
import type { CallResult, FetchFn } from "./openai.ts";

const MODELS = ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-6-sol"].map((name) => modelSpecFor(name));
const GPT_4O = modelSpecFor("gpt-4o");
const endpoint = (baseUrl: string, apiKey: string) => () => ({ baseUrl, apiKey });

const benchCase = (id: string): BenchCase => ({
  id,
  stage: "s3",
  label: id,
  messages: [{ role: "user", content: `question ${id}` }],
});

const call = (overrides: Partial<CallResult> = {}): CallResult => ({
  status: 200,
  elapsedMs: 1000,
  text: "ok",
  usage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 0 },
  error: null,
  rateLimit: {},
  ...overrides,
});

const jobResult = (overrides: Partial<JobResult> = {}): JobResult => ({
  ...call(),
  caseId: "c1",
  model: "gpt-4o",
  provider: "openai",
  round: 1,
  overProductionTimeout: false,
  cutOffBeforeProductionTimeout: false,
  costUsd: 0.001,
  finishedOrder: 1,
  ...overrides,
});

describe("planJobs", () => {
  it("calls every model once per case and round", () => {
    const jobs = planJobs([benchCase("a"), benchCase("b")], MODELS, 2);
    expect(jobs).toHaveLength(16);
    for (const id of ["a", "b"]) {
      for (const round of [1, 2]) {
        const names = jobs
          .filter((job) => job.caseId === id && job.round === round)
          .map((job) => job.model.name);
        expect([...names].sort()).toEqual(MODELS.map((model) => model.name).sort());
      }
    }
  });

  it("rotates which model goes first from one case to the next", () => {
    const cases = ["a", "b", "c", "d", "e"].map(benchCase);
    const firsts = cases.map(
      (_, index) => planJobs(cases, MODELS, 1)[index * MODELS.length]?.model.name,
    );
    expect(firsts).toEqual(["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-6-sol", "gpt-4o"]);
  });

  it("keeps rotating across rounds instead of starting over", () => {
    const jobs = planJobs([benchCase("a")], MODELS, 2);
    expect(jobs[0]?.model.name).toBe("gpt-4o");
    expect(jobs[4]?.model.name).toBe("gpt-4.1");
  });

  it("works with a single model", () => {
    expect(planJobs([benchCase("a")], [modelSpecFor("gpt-4o")], 3)).toHaveLength(3);
  });
});

describe("costOf", () => {
  it("prices input and output per million tokens", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 500_000, reasoningTokens: 0 };
    expect(costOf(usage, { input: 2.5, output: 10 })).toBeCloseTo(7.5);
    expect(costOf(usage, { input: 0.4, output: 1.6 })).toBeCloseTo(1.2);
  });

  it("is 0 for no tokens and unknown without a usage or a price", () => {
    expect(
      costOf({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }, { input: 1, output: 1 }),
    ).toBe(0);
    expect(costOf(null, { input: 1, output: 1 })).toBeNull();
    expect(costOf({ promptTokens: 1, completionTokens: 1, reasoningTokens: 0 }, null)).toBeNull();
  });
});

describe("isOverProductionTimeout", () => {
  it("marks calls slower than the Worker's 20 seconds, not those at exactly 20", () => {
    expect(isOverProductionTimeout(call({ elapsedMs: 20_000 }))).toBe(false);
    expect(isOverProductionTimeout(call({ elapsedMs: 20_001 }))).toBe(true);
  });

  it("marks a call cut off at or after 20 seconds as late", () => {
    const timeout = { kind: "timeout" as const, message: "t" };
    expect(isOverProductionTimeout(call({ elapsedMs: 20_000, error: timeout }))).toBe(true);
    expect(isCutOffBeforeProductionTimeout(call({ elapsedMs: 20_000, error: timeout }))).toBe(
      false,
    );
  });

  it("does not count a call cut off before 20 seconds as late: it cannot be told", () => {
    const cutOff = call({ elapsedMs: 5_000, error: { kind: "timeout", message: "t" } });
    expect(isOverProductionTimeout(cutOff)).toBe(false);
    expect(isCutOffBeforeProductionTimeout(cutOff)).toBe(true);
    const lost = call({ elapsedMs: 5, error: { kind: "network", message: "n" } });
    expect(isOverProductionTimeout(lost)).toBe(false);
    expect(isCutOffBeforeProductionTimeout(lost)).toBe(false);
    expect(isCutOffBeforeProductionTimeout(call({ elapsedMs: 5 }))).toBe(false);
  });
});

describe("median", () => {
  it("handles odd, even, single and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });
});

describe("summarizeModel", () => {
  it("summarizes one model, timing only the successful calls", () => {
    const results = [
      jobResult({ elapsedMs: 1000, costUsd: 0.01 }),
      jobResult({ elapsedMs: 3000, costUsd: 0.02 }),
      jobResult({ elapsedMs: 25_000, costUsd: 0.03, overProductionTimeout: true }),
      jobResult({
        elapsedMs: 60_000,
        error: { kind: "timeout", message: "t" },
        usage: null,
        costUsd: null,
        overProductionTimeout: true,
      }),
      jobResult({ model: "gpt-4.1", elapsedMs: 99_999 }),
    ];
    const summary = summarizeModel(GPT_4O, results);
    expect(summary).toMatchObject({
      model: "gpt-4o",
      calls: 4,
      medianMs: 3000,
      maxMs: 25_000,
      overProductionTimeout: 2,
      errors: 1,
      promptTokens: 300,
      completionTokens: 150,
    });
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.costLowerBoundUsd).toBeCloseTo(0.06);
  });

  it("leaves the total cost unknown when a reply came without usage, instead of undercounting", () => {
    const results = [
      jobResult({ costUsd: 0.01 }),
      jobResult({ usage: null, costUsd: null }),
      jobResult({ error: { kind: "http_error", message: "x" }, usage: null, costUsd: 0 }),
    ];
    const summary = summarizeModel(GPT_4O, results);
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.usageUnknown).toBe(1);
    expect(summary.promptTokens).toBe(100);
  });

  it("does not let failed calls without usage make the total unknown", () => {
    const results = [
      jobResult({ costUsd: 0.01 }),
      jobResult({ error: { kind: "http_error", message: "x" }, usage: null, costUsd: 0 }),
    ];
    expect(summarizeModel(GPT_4O, results)).toMatchObject({
      totalCostUsd: 0.01,
      usageUnknown: 0,
    });
  });

  it("prices a rejected request at 0 but a cut-off or lost call as unknown", () => {
    const price = { input: 2.5, output: 10 };
    const rejected = call({
      status: 429,
      usage: null,
      error: { kind: "http_error", message: "x" },
    });
    expect(callCost(rejected, price)).toBe(0);
    expect(callCost(rejected, null)).toBe(0);
    for (const kind of ["timeout", "network", "invalid_response"] as const) {
      expect(callCost(call({ usage: null, error: { kind, message: "x" } }), price)).toBeNull();
    }
    expect(callCost(call({ usage: null }), price)).toBeNull();
    expect(callCost(call(), price)).toBeCloseTo((100 * 2.5 + 50 * 10) / 1_000_000);
  });

  it("leaves the total unknown, with the known part as a lower bound, after a timeout", () => {
    const results = [
      jobResult({ costUsd: 0.01 }),
      jobResult({ costUsd: 0, usage: null, error: { kind: "http_error", message: "x" } }),
      jobResult({ costUsd: null, usage: null, error: { kind: "timeout", message: "t" } }),
    ];
    expect(summarizeModel(GPT_4O, results)).toMatchObject({
      totalCostUsd: null,
      costLowerBoundUsd: 0.01,
    });
  });

  it("reports nothing measured for a model whose every call failed", () => {
    const failed = jobResult({
      error: { kind: "http_error", message: "x" },
      usage: null,
      costUsd: 0,
    });
    expect(summarizeModel(GPT_4O, [failed])).toMatchObject({
      medianMs: null,
      maxMs: null,
      totalCostUsd: 0,
      errors: 1,
    });
  });

  it("keeps the rate-limit headers of the call that finished last", () => {
    const results = [
      jobResult({ finishedOrder: 3, rateLimit: { "x-ratelimit-remaining-requests": "7" } }),
      jobResult({ finishedOrder: 5, rateLimit: { "x-ratelimit-remaining-requests": "5" } }),
      jobResult({ finishedOrder: 6, rateLimit: {} }),
      jobResult({ finishedOrder: 4, rateLimit: { "x-ratelimit-remaining-requests": "6" } }),
    ];
    expect(summarizeModel(GPT_4O, results).rateLimit).toEqual({
      "x-ratelimit-remaining-requests": "5",
    });
  });
});

describe("runJobs", () => {
  const okFetch =
    (delays: Map<string, number>, inFlight: { now: number; max: number }): FetchFn =>
    async (_url, init) => {
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      const body = typeof init.body === "string" ? init.body : "";
      const model = /"model":"([^"]+)"/.exec(body)?.[1] ?? "";
      await new Promise((resolve) => setTimeout(resolve, delays.get(model) ?? 1));
      inFlight.now -= 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `reply from ${model}` } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
      );
    };

  it("never has more calls in flight than the concurrency and keeps the job order", async () => {
    const cases = ["a", "b", "c"].map(benchCase);
    const jobs = planJobs(cases, MODELS, 1);
    const inFlight = { now: 0, max: 0 };
    const progress: number[] = [];
    const results = await runJobs(
      jobs,
      cases,
      {
        endpointFor: endpoint("https://api.example.test/v1", "sk-x"),
        timeoutMs: 1000,
        concurrency: 2,
        onResult: (_result, done) => progress.push(done),
      },
      {
        fetch: okFetch(new Map([["gpt-4o", 5]]), inFlight),
        clock: { now: () => 0 },
      },
    );
    expect(inFlight.max).toBe(2);
    expect(results.map((result) => [result.caseId, result.model])).toEqual(
      jobs.map((job) => [job.caseId, job.model.name]),
    );
    expect(results[0]?.text).toBe("reply from gpt-4o");
    expect(results[0]?.costUsd).toBeCloseTo((1000 * 2.5 + 100 * 10) / 1_000_000);
    expect(progress).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect([...results.map((result) => result.finishedOrder)].sort((a, b) => a - b)).toEqual(
      progress,
    );
  });

  it("runs one at a time with concurrency 1 and copes with no jobs", async () => {
    const inFlight = { now: 0, max: 0 };
    const deps = { fetch: okFetch(new Map(), inFlight), clock: { now: () => 0 } };
    const options = { endpointFor: endpoint("u", "k"), timeoutMs: 1000, concurrency: 1 };
    const cases = [benchCase("a")];
    await runJobs(planJobs(cases, MODELS, 1), cases, options, deps);
    expect(inFlight.max).toBe(1);
    expect(await runJobs([], [], options, deps)).toEqual([]);
  });

  it("counts a call cut off by a --timeout-ms under 20 seconds apart from the late ones", async () => {
    const cases = [benchCase("a")];
    const hang: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    let now = 0;
    const results = await runJobs(
      planJobs(cases, [modelSpecFor("gpt-4o")], 1),
      cases,
      { endpointFor: endpoint("u", "k"), timeoutMs: 20, concurrency: 1 },
      { fetch: hang, clock: { now: () => (now += 10) } },
    );
    expect(results[0]).toMatchObject({
      error: { kind: "timeout" },
      overProductionTimeout: false,
      cutOffBeforeProductionTimeout: true,
    });
    expect(summarize([modelSpecFor("gpt-4o")], results)[0]).toMatchObject({
      overProductionTimeout: 0,
      cutOffBeforeProductionTimeout: 1,
      totalCostUsd: null,
      costLowerBoundUsd: 0,
    });
  });

  it("sends each model to its own provider with that provider's key, and sums per provider", async () => {
    const cases = [benchCase("a")];
    const mixed = ["gpt-4.1-mini", "gemini-3.8-flash", "claude-haiku-5-5"].map((name) =>
      modelSpecFor(name),
    );
    const endpoints = {
      openai: { baseUrl: "https://openai.test/v1", apiKey: "sk-openai" },
      gemini: { baseUrl: "https://gemini.test/v1beta/openai", apiKey: "AIza-gemini" },
      anthropic: { baseUrl: "https://anthropic.test/v1", apiKey: "sk-ant-anthropic" },
    } as const;
    const seen: [string, string | null, string][] = [];
    const fetch: FetchFn = (url, init) => {
      const body = typeof init.body === "string" ? init.body : "";
      seen.push([url, new Headers(init.headers).get("authorization"), body]);
      const headers: Record<string, string> = url.startsWith("https://gemini.test")
        ? {}
        : { "x-ratelimit-remaining-requests": url.startsWith("https://openai") ? "9" : "8" };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
          }),
          { headers },
        ),
      );
    };
    const results = await runJobs(
      planJobs(cases, mixed, 1),
      cases,
      { endpointFor: (provider) => endpoints[provider], timeoutMs: 1000, concurrency: 1 },
      { fetch, clock: { now: () => 0 } },
    );
    expect([...seen].sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      [
        "https://anthropic.test/v1/chat/completions",
        "Bearer sk-ant-anthropic",
        expect.stringContaining('"thinking":{"type":"disabled"}'),
      ],
      [
        "https://gemini.test/v1beta/openai/chat/completions",
        "Bearer AIza-gemini",
        expect.stringContaining('"reasoning_effort":"minimal"'),
      ],
      ["https://openai.test/v1/chat/completions", "Bearer sk-openai", expect.any(String)],
    ]);
    const summaries = summarize(mixed, results);
    expect(summaries.map((summary) => [summary.model, summary.provider])).toEqual([
      ["gpt-4.1-mini", "openai"],
      ["gemini-3.8-flash", "gemini"],
      ["claude-haiku-5-5", "anthropic"],
    ]);
    // One million input tokens each: the cost is each provider's input price.
    expect(summaries.map((summary) => summary.totalCostUsd)).toEqual([0.4, 0.75, 0.1]);
    expect(summaries.map((summary) => summary.rateLimit)).toEqual([
      { "x-ratelimit-remaining-requests": "9" },
      {},
      { "x-ratelimit-remaining-requests": "8" },
    ]);
  });

  it("keeps two models of the same name from different providers apart", () => {
    const openai = modelSpecFor("shared-name", "openai");
    const gemini = modelSpecFor("shared-name", "gemini");
    const results = [
      jobResult({ model: "shared-name", provider: "openai", elapsedMs: 1000 }),
      jobResult({ model: "shared-name", provider: "gemini", elapsedMs: 3000 }),
      jobResult({ model: "shared-name", provider: "gemini", elapsedMs: 5000 }),
    ];
    expect(summarizeModel(openai, results)).toMatchObject({ calls: 1, medianMs: 1000 });
    expect(summarizeModel(gemini, results)).toMatchObject({ calls: 2, medianMs: 4000 });
  });

  it("keeps going after a failure and records it", async () => {
    const cases = [benchCase("a")];
    const fetch: FetchFn = (_url, init) =>
      typeof init.body === "string" && init.body.includes("gpt-4.1-mini")
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(
            new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })),
          );
    const results = await runJobs(
      planJobs(cases, MODELS, 1),
      cases,
      { endpointFor: endpoint("u", "k"), timeoutMs: 1000, concurrency: 2 },
      { fetch, clock: { now: () => 0 } },
    );
    expect(results).toHaveLength(4);
    const summaries = summarize(MODELS, results);
    expect(summaries.map((summary) => summary.errors)).toEqual([0, 0, 1, 0]);
  });
});
