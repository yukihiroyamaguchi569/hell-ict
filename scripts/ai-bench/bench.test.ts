import { describe, expect, it } from "vitest";

import {
  costOf,
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

const MODELS = ["gpt-4o", "gpt-4.1", "gpt-4.1-mini", "gpt-6-sol"].map(modelSpecFor);

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
  round: 1,
  overProductionTimeout: false,
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

  it("marks a call we gave up on, whatever its duration", () => {
    expect(
      isOverProductionTimeout(call({ elapsedMs: 5, error: { kind: "timeout", message: "t" } })),
    ).toBe(true);
    expect(
      isOverProductionTimeout(call({ elapsedMs: 5, error: { kind: "network", message: "n" } })),
    ).toBe(false);
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
    const summary = summarizeModel("gpt-4o", results);
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
    expect(summary.totalCostUsd).toBeCloseTo(0.06);
  });

  it("reports nothing measured for a model whose every call failed", () => {
    const failed = jobResult({
      error: { kind: "http_error", message: "x" },
      usage: null,
      costUsd: null,
    });
    expect(summarizeModel("gpt-4o", [failed])).toMatchObject({
      medianMs: null,
      maxMs: null,
      totalCostUsd: null,
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
    expect(summarizeModel("gpt-4o", results).rateLimit).toEqual({
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
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-x",
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
    const options = { baseUrl: "u", apiKey: "k", timeoutMs: 1000, concurrency: 1 };
    const cases = [benchCase("a")];
    await runJobs(planJobs(cases, MODELS, 1), cases, options, deps);
    expect(inFlight.max).toBe(1);
    expect(await runJobs([], [], options, deps)).toEqual([]);
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
      { baseUrl: "u", apiKey: "k", timeoutMs: 1000, concurrency: 2 },
      { fetch, clock: { now: () => 0 } },
    );
    expect(results).toHaveLength(4);
    const summaries = summarize(MODELS, results);
    expect(summaries.map((summary) => summary.errors)).toEqual([0, 0, 1, 0]);
  });
});
