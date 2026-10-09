import { describe, expect, it } from "vitest";

import type { BenchCase } from "./cases.ts";
import { modelSpecFor } from "./config.ts";
import type { ModelPrice, ModelSpec } from "./config.ts";
import { estimateCallCost, rateLimitStop, runLoad } from "./load.ts";
import type { LoadLimits, LoadPlan } from "./load.ts";
import type { CallDeps, CallResult, FetchFn } from "./openai.ts";

const PRICE: ModelPrice = { input: 0.4, output: 1.6 };
const MODEL: ModelSpec & { price: ModelPrice } = { ...modelSpecFor("gpt-4.1-mini"), price: PRICE };

const benchCase = (id: string): BenchCase => ({
  id,
  stage: "s4",
  label: id,
  messages: [{ role: "user", content: "あ".repeat(1000) }],
});
const CASES = ["a", "b", "c"].map(benchCase);

const LIMITS: LoadLimits = {
  maxRequests: 1_000,
  maxCostUsd: 1_000,
  max429InARow: 1_000,
  max429Ratio: 1,
  ratioMinSample: 1_000,
};

const plan = (overrides: Partial<LoadPlan> = {}): LoadPlan => ({
  cases: CASES,
  model: MODEL,
  concurrency: 4,
  durationMs: 1_000,
  timeoutMs: 60_000,
  baseUrl: "https://api.example.test/v1",
  apiKey: "sk-load-test",
  limits: LIMITS,
  ...overrides,
});

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const ok = (usage: unknown = { prompt_tokens: 1000, completion_tokens: 100 }): Reply => ({
  status: 200,
  body: { choices: [{ message: { content: "ok" } }], ...(usage === null ? {} : { usage }) },
});
const limited: Reply = {
  status: 429,
  body: { error: { code: "rate_limit_exceeded", type: "requests" } },
};

/**
 * A fake API on a manual clock: each call takes `stepMs` of fake time, counted when it answers.
 * It records how many calls were in flight at most and how many it received.
 */
const fakeApi = (reply: (index: number) => Reply, stepMs = 100) => {
  let now = 0;
  const seen = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const fetch: FetchFn = async () => {
    const index = seen.calls;
    seen.calls += 1;
    seen.inFlight += 1;
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    now += stepMs;
    seen.inFlight -= 1;
    const { status, body, headers } = reply(index);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const deps: CallDeps = { fetch, clock: { now: () => now } };
  return { deps, seen };
};

describe("runLoad (continuous)", () => {
  it("keeps exactly N calls in flight, never more, until the duration is up", async () => {
    const { deps, seen } = fakeApi(() => ok());
    const outcome = await runLoad(plan({ concurrency: 4, durationMs: 1_000 }), deps);
    expect(seen.maxInFlight).toBe(4);
    expect(outcome.stopReason).toBe("duration");
    expect(outcome.calls.every((call) => call.startMs < 1_000)).toBe(true);
    expect(outcome.calls).toHaveLength(seen.calls);
    expect(outcome.calls.length).toBeGreaterThan(4);
  });

  it("uses the cases in turn and records every call in start order", async () => {
    const { deps } = fakeApi(() => ok());
    const outcome = await runLoad(plan({ concurrency: 2, durationMs: 500 }), deps);
    expect(outcome.calls.map((call) => call.seq)).toEqual(outcome.calls.map((_, index) => index));
    expect(outcome.calls.slice(0, 4).map((call) => call.caseId)).toEqual(["a", "b", "c", "a"]);
  });

  it("stops at the request cap", async () => {
    const { deps, seen } = fakeApi(() => ok());
    const outcome = await runLoad(
      plan({ concurrency: 3, durationMs: 1e9, limits: { ...LIMITS, maxRequests: 10 } }),
      deps,
    );
    expect(seen.calls).toBe(10);
    expect(outcome.stopReason).toBe("max-requests");
  });

  it("stops before the cost cap, counting calls whose cost is unknown at their estimate", async () => {
    const estimate = estimateCallCost(benchCase("a"), PRICE);
    const { deps, seen } = fakeApi(() => ok(null));
    const outcome = await runLoad(
      plan({ concurrency: 2, durationMs: 1e9, limits: { ...LIMITS, maxCostUsd: estimate * 3.5 } }),
      deps,
    );
    expect(seen.calls).toBe(3);
    expect(outcome.stopReason).toBe("max-cost");
  });

  it("counts the actual cost once a call answers, so cheap calls leave room for more", async () => {
    const estimate = estimateCallCost(benchCase("a"), PRICE);
    const { deps, seen } = fakeApi(() => ok({ prompt_tokens: 1, completion_tokens: 1 }));
    const outcome = await runLoad(
      plan({
        concurrency: 1,
        durationMs: 1e9,
        limits: { ...LIMITS, maxCostUsd: estimate * 3.5, maxRequests: 20 },
      }),
      deps,
    );
    expect(seen.calls).toBe(20);
    expect(outcome.stopReason).toBe("max-requests");
  });

  it("stops after K 429s in a row, starting nothing more", async () => {
    const { deps, seen } = fakeApi(() => limited);
    const outcome = await runLoad(
      plan({ concurrency: 2, durationMs: 1e9, limits: { ...LIMITS, max429InARow: 5 } }),
      deps,
    );
    expect(outcome.stopReason).toBe("429-in-a-row");
    // The 5th 429 stops new calls; the other worker's call already in flight still finishes.
    expect(seen.calls).toBeLessThanOrEqual(6);
    expect(seen.calls).toBeGreaterThanOrEqual(5);
  });

  it("stops when the share of 429s reaches the ratio", async () => {
    const { deps } = fakeApi((index) => (index % 2 === 0 ? limited : ok()));
    const outcome = await runLoad(
      plan({
        concurrency: 1,
        durationMs: 1e9,
        limits: { ...LIMITS, max429Ratio: 0.5, ratioMinSample: 4 },
      }),
      deps,
    );
    expect(outcome.stopReason).toBe("429-ratio");
    expect(outcome.calls).toHaveLength(4);
  });

  it("records the start and end time of each call relative to the run", async () => {
    const { deps } = fakeApi(() => ok(), 250);
    const outcome = await runLoad(plan({ concurrency: 1, durationMs: 600 }), deps);
    expect(outcome.calls.map((call) => [call.startMs, call.endMs])).toEqual([
      [0, 250],
      [250, 500],
      [500, 750],
    ]);
    expect(outcome.wallMs).toBe(750);
  });
});

describe("runLoad (burst)", () => {
  it("starts N calls at once and nothing after them", async () => {
    const { deps, seen } = fakeApi(() => ok());
    const outcome = await runLoad(plan({ concurrency: 7, durationMs: null }), deps);
    expect(seen.calls).toBe(7);
    expect(seen.maxInFlight).toBe(7);
    expect(outcome.calls.every((call) => call.startMs === 0)).toBe(true);
    expect(outcome.stopReason).toBe("burst-done");
  });

  it("still keeps to the request cap", async () => {
    const { deps, seen } = fakeApi(() => ok());
    const outcome = await runLoad(
      plan({ concurrency: 7, durationMs: null, limits: { ...LIMITS, maxRequests: 3 } }),
      deps,
    );
    expect(seen.calls).toBe(3);
    expect(outcome.stopReason).toBe("max-requests");
  });
});

describe("rateLimitStop", () => {
  const call = (status: number): CallResult => ({
    status,
    elapsedMs: 1,
    text: null,
    usage: null,
    error: status === 200 ? null : { kind: "http_error", message: "x" },
    rateLimit: {},
  });
  const limits = { ...LIMITS, max429InARow: 3, max429Ratio: 0.5, ratioMinSample: 6 };

  it("counts only the latest run of 429s", () => {
    expect(rateLimitStop([429, 429, 200, 429, 429].map(call), limits)).toBeNull();
    expect(rateLimitStop([200, 429, 429, 429].map(call), limits)).toBe("429-in-a-row");
  });

  it("checks the ratio only after the minimum sample", () => {
    expect(rateLimitStop([429, 200, 429, 200, 429].map(call), limits)).toBeNull();
    expect(rateLimitStop([429, 200, 429, 200, 429, 200].map(call), limits)).toBe("429-ratio");
    expect(rateLimitStop([429, 200, 200, 200, 429, 200].map(call), limits)).toBeNull();
  });

  it("does not count other errors as 429", () => {
    expect(rateLimitStop([500, 500, 500].map(call), limits)).toBeNull();
    expect(rateLimitStop([], limits)).toBeNull();
  });
});
