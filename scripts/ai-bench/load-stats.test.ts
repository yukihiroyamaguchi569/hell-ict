import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BenchCase } from "./cases.ts";
import type { LoadCall } from "./load.ts";
import { estimateLoad, parseLoadArgs } from "./load-cli.ts";
import { renderLoadReport } from "./load-report.ts";
import { outcomeKey, percentile, perSecond, summarizeCalls } from "./load-stats.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const loadCall = (overrides: Partial<LoadCall> = {}): LoadCall => ({
  seq: 0,
  caseId: "a",
  startMs: 0,
  endMs: 1_000,
  status: 200,
  elapsedMs: 1_000,
  text: "ok",
  usage: { promptTokens: 2_600, completionTokens: 300, reasoningTokens: 0 },
  error: null,
  rateLimit: {},
  costUsd: 0.001,
  ...overrides,
});

const rateLimited = (overrides: Partial<LoadCall> = {}): LoadCall =>
  loadCall({
    status: 429,
    text: null,
    usage: null,
    costUsd: 0,
    error: { kind: "http_error", message: "rate_limit_exceeded / requests" },
    ...overrides,
  });

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("summarizeCalls", () => {
  const calls = [
    loadCall({
      elapsedMs: 2_000,
      rateLimit: {
        "x-ratelimit-remaining-requests": "9990",
        "x-ratelimit-remaining-tokens": "9000000",
      },
    }),
    loadCall({
      elapsedMs: 4_000,
      rateLimit: {
        "x-ratelimit-remaining-requests": "9980",
        "x-ratelimit-remaining-tokens": "8500000",
      },
    }),
    rateLimited({ elapsedMs: 10 }),
    loadCall({
      status: 429,
      text: null,
      usage: null,
      costUsd: 0,
      error: { kind: "http_error", message: "insufficient_quota" },
    }),
    loadCall({
      status: null,
      text: null,
      usage: null,
      costUsd: null,
      elapsedMs: 21_000,
      error: { kind: "timeout", message: "t" },
    }),
    loadCall({
      status: null,
      text: null,
      usage: null,
      costUsd: null,
      elapsedMs: 5,
      error: { kind: "network", message: "n" },
    }),
  ];
  const summary = summarizeCalls(calls, 30_000);

  it("counts completions, successes, 429s, late calls and lost connections", () => {
    expect(summary).toMatchObject({
      completed: 6,
      succeeded: 2,
      rateLimited: 2,
      overProductionTimeout: 1,
      network: 1,
    });
  });

  it("breaks the results down by status and error code", () => {
    expect(summary.outcomes).toEqual({
      "200 ok": 2,
      "429 rate_limit_exceeded / requests": 1,
      "429 insufficient_quota": 1,
      timeout: 1,
      network: 1,
    });
    expect(
      outcomeKey(loadCall({ status: 500, error: { kind: "http_error", message: "server_error" } })),
    ).toBe("500 server_error");
  });

  it("times the successful calls only", () => {
    expect(summary).toMatchObject({ p50Ms: 2_000, p95Ms: 4_000, p99Ms: 4_000, maxMs: 4_000 });
  });

  it("turns the counts into a rate per minute", () => {
    // 6 calls and 5,800 tokens in 30 seconds.
    expect(summary.rpm).toBe(12);
    expect(summary.tpm).toBe(11_600);
    expect(summary.tokens).toBe(5_800);
  });

  it("keeps the lowest remaining rate limit seen", () => {
    expect(summary.minRemainingRequests).toBe(9_980);
    expect(summary.minRemainingTokens).toBe(8_500_000);
  });

  it("leaves the cost unknown with a lower bound when a call may have been billed", () => {
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.costLowerBoundUsd).toBeCloseTo(0.002);
    expect(summarizeCalls(calls.slice(0, 4), 1_000).totalCostUsd).toBeCloseTo(0.002);
  });

  it("copes with no calls and a zero window", () => {
    expect(summarizeCalls([], 0)).toMatchObject({
      completed: 0,
      p50Ms: null,
      maxMs: null,
      rpm: 0,
      tpm: 0,
      minRemainingRequests: null,
      totalCostUsd: 0,
    });
  });

  it("ignores a rate-limit header that is not a number", () => {
    const odd = summarizeCalls(
      [loadCall({ rateLimit: { "x-ratelimit-remaining-requests": "n/a" } })],
      1_000,
    );
    expect(odd.minRemainingRequests).toBeNull();
  });
});

describe("perSecond", () => {
  it("puts each call in the second it finished, and counts starts separately", () => {
    const calls = [
      loadCall({ startMs: 0, endMs: 900 }),
      loadCall({ startMs: 100, endMs: 1_500 }),
      loadCall({ startMs: 1_200, endMs: 2_000 }),
      rateLimited({ startMs: 1_900, endMs: 1_950 }),
    ];
    const rows = perSecond(calls, 2_000);
    expect(rows.map((row) => [row.second, row.started, row.completed, row.rateLimited])).toEqual([
      [0, 2, 1, 0],
      [1, 2, 2, 1],
      [2, 0, 1, 0],
    ]);
    expect(rows[0]?.rpm).toBe(60);
    expect(rows[0]?.tpm).toBe(2_900 * 60);
  });

  it("has one row for a run shorter than a second", () => {
    expect(perSecond([], 0)).toHaveLength(1);
  });
});

describe("parseLoadArgs / estimateLoad", () => {
  const cases: BenchCase[] = [
    { id: "a", stage: "s4", label: "l", messages: [{ role: "user", content: "あ".repeat(2_600) }] },
  ];

  it("defaults to gpt-4.1-mini, 60 in flight for 60 s, with the safety caps", () => {
    const options = parseLoadArgs(["--cases", "c.json"]);
    expect(options).toMatchObject({
      concurrency: 60,
      durationMs: 60_000,
      timeoutMs: 60_000,
      limits: { maxRequests: 1_500, maxCostUsd: 5, max429InARow: 20, max429Ratio: 0.5 },
      yes: false,
      dryRun: false,
    });
    expect(options.model).toMatchObject({
      name: "gpt-4.1-mini",
      price: { input: 0.4, output: 1.6 },
    });
  });

  it("takes a burst and other settings", () => {
    const options = parseLoadArgs([
      "--cases=c",
      "--burst",
      "--concurrency=10",
      "--model=gpt-4o",
      "--max-cost-usd=0.5",
      "--max-429-ratio=0.2",
      "--yes",
    ]);
    expect(options).toMatchObject({ durationMs: null, concurrency: 10, yes: true });
    expect(options.limits).toMatchObject({ maxCostUsd: 0.5, max429Ratio: 0.2 });
  });

  it.each([
    [["--concurrency", "0"], /--concurrency/],
    [["--concurrency", "1.5"], /--concurrency/],
    [["--max-cost-usd", "-1"], /--max-cost-usd/],
    [["--duration-s", "abc"], /--duration-s/],
    [["--max-429-ratio", "1.5"], /at most 1/],
    [["--model", "gpt-unknown"], /no price/],
    [["--api-key", "sk-x"], /api-key/],
  ])("rejects %j", (args, message) => {
    expect(() => parseLoadArgs(["--cases", "c", ...args])).toThrow(message);
  });

  it("requires --cases", () => {
    expect(() => parseLoadArgs([])).toThrow(/--cases is required/);
  });

  it("estimates calls from concurrency, duration and latency, held to the caps", () => {
    const perCall = (2_604 * 0.4 + 300 * 1.6) / 1_000_000;
    const base = parseLoadArgs(["--cases", "c", "--concurrency", "10", "--duration-s", "12"]);
    // 10 in flight × 12 s ÷ 2.4 s = 50 calls.
    expect(estimateLoad(cases, base).requests).toBe(50);
    expect(estimateLoad(cases, base).costUsd).toBeCloseTo(50 * perCall);
    const capped = parseLoadArgs(["--cases", "c", "--max-requests", "20"]);
    expect(estimateLoad(cases, capped).requests).toBe(20);
    const cheap = parseLoadArgs(["--cases", "c", "--max-cost-usd", String(perCall * 7.5)]);
    expect(estimateLoad(cases, cheap).requests).toBe(7);
    const burst = parseLoadArgs(["--cases", "c", "--burst"]);
    expect(estimateLoad(cases, burst).requests).toBe(60);
  });
});

describe("renderLoadReport", () => {
  const calls = [loadCall({ text: "<b>reply</b>" }), rateLimited({ endMs: 1_500 })];
  const html = renderLoadReport({
    startedAt: "2026-10-10T00:00:00.000Z",
    model: "gpt-4.1-mini",
    concurrency: 60,
    durationMs: 60_000,
    timeoutMs: 60_000,
    casesCount: 12,
    outcome: { calls, stopReason: "429-in-a-row", wallMs: 1_500 },
    summary: summarizeCalls(calls, 1_500),
    seconds: perSecond(calls, 1_500),
  });

  it("shows the settings, the stop reason, the summary and one row per second", () => {
    expect(html).toContain("同時 60 件を 60 秒");
    expect(html).toContain("429 が続いた");
    expect(html).toContain("<th>429 rate_limit_exceeded / requests</th><td>1</td>");
    expect(html).toContain("<th>RPM（実測、1 分あたり）</th><td>80</td>");
    expect(html.match(/<tr><th>[01]<\/th>/g)).toHaveLength(2);
  });

  it("is self-contained and leaves the reply texts out", () => {
    expect(html).not.toMatch(/<(script|link)\b/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("reply");
  });
});

describe("load-main (as a process)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ai-bench-load-"));
  const casesPath = path.join(dir, "cases.json");
  writeFileSync(
    casesPath,
    JSON.stringify([
      { id: "a", stage: "s4", label: "l", messages: [{ role: "user", content: "q" }] },
    ]),
  );
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(HERE, "load-main.ts"), ...args], {
      encoding: "utf8",
      input: "",
      env: { PATH: process.env.PATH ?? "", OPENAI_BASE_URL: "http://127.0.0.1:9/v1", ...env },
    });

  it("shows the estimate in a dry run, without a key", () => {
    const result = run(["--cases", casesPath, "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("expected: about 1500 calls");
  });

  it("stops before calling anything when the key is missing", () => {
    const result = run(["--cases", casesPath, "--out", path.join(dir, "out")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENAI_API_KEY is not set");
  });

  it("asks before starting, and refuses without a terminal unless --yes is given", () => {
    const result = run(["--cases", casesPath, "--out", path.join(dir, "out")], {
      OPENAI_API_KEY: "sk-test-not-used",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pass --yes");
    expect(result.stderr).not.toContain("sk-test-not-used");
  });
});
