import { describe, expect, it } from "vitest";

import { costOf, isOverProductionTimeout, summarize } from "./bench.ts";
import type { JobResult } from "./bench.ts";
import { modelSpecFor } from "./config.ts";
import { callModel } from "./openai.ts";
import type { FetchFn } from "./openai.ts";
import { escapeHtml, formatUsd, renderReport } from "./report.ts";
import type { BenchRun } from "./report.ts";

const KEY = "sk-report-SECRET-987";
const MODELS = ["gpt-4o", "gpt-6-sol"].map(modelSpecFor);
const benchCase = {
  id: "s5-table",
  stage: "s5",
  label: "表の整形",
  messages: [
    { role: "system" as const, content: "SYSTEM <b>" },
    { role: "user" as const, content: "<script>alert(1)</script>" },
  ],
};

/** Runs real callModel against Fake fetches, so the report is built from what a run records. */
const resultsFrom = async (): Promise<JobResult[]> => {
  const fetches: Record<string, FetchFn> = {
    "gpt-4o": () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "| a | b |\n<i>ok</i>" } }],
            usage: { prompt_tokens: 1200, completion_tokens: 300 },
          }),
          {
            headers: {
              "x-ratelimit-limit-requests": "5000",
              "x-ratelimit-remaining-tokens": "799",
            },
          },
        ),
      ),
    "gpt-6-sol": () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: `Incorrect API key provided: ${KEY}`, code: "invalid_api_key" },
          }),
          { status: 401 },
        ),
      ),
  };
  return Promise.all(
    MODELS.map(async (model, index) => {
      const call = await callModel(
        { baseUrl: "u", apiKey: KEY, model, messages: benchCase.messages, timeoutMs: 1000 },
        {
          fetch: fetches[model.name] ?? (() => Promise.reject(new Error())),
          clock: { now: () => index * 25_000 },
        },
      );
      const slow = { ...call, elapsedMs: model.name === "gpt-4o" ? 21_500 : call.elapsedMs };
      return {
        ...slow,
        caseId: benchCase.id,
        model: model.name,
        round: 1,
        overProductionTimeout: isOverProductionTimeout(slow),
        costUsd: costOf(slow.usage, model.price),
        finishedOrder: index + 1,
      };
    }),
  );
};

const runOf = (results: JobResult[]): BenchRun => ({
  startedAt: "2026-10-10T00:00:00.000Z",
  models: MODELS.map((model) => model.name),
  repeat: 1,
  concurrency: 2,
  timeoutMs: 60_000,
  cases: [benchCase],
  results,
  summaries: summarize(MODELS, results),
});

describe("escapeHtml / formatUsd", () => {
  it("escapes the five HTML characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("shows small costs with more digits and an unknown one as unknown", () => {
    expect(formatUsd(0.0042)).toBe("$0.00420");
    expect(formatUsd(1.5)).toBe("$1.500");
    expect(formatUsd(null)).toBe("不明");
  });
});

describe("renderReport", () => {
  it("never contains the API key, also when an error body quoted it", async () => {
    const html = renderReport(runOf(await resultsFrom()));
    expect(html).not.toContain(KEY);
    expect(html).not.toContain("SECRET");
    expect(JSON.stringify(runOf(await resultsFrom()))).not.toContain(KEY);
  });

  it("puts each model's reply side by side, escaped", async () => {
    const html = renderReport(runOf(await resultsFrom()));
    expect(html).toContain('<div class="cols" style="--cols:2">');
    expect(html).toContain("<h3>gpt-4o</h3>");
    expect(html).toContain("<h3>gpt-6-sol</h3>");
    expect(html).toContain("&lt;i&gt;ok&lt;/i&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("エラー（http_error）: invalid_api_key");
  });

  it("marks a call slower than the Worker's timeout and shows tokens and cost", async () => {
    const html = renderReport(runOf(await resultsFrom()));
    expect(html).toContain("本番ならタイムアウト（20 秒超）");
    expect(html).toContain("21.5 秒 · 入力 1200 / 出力 300 · $0.00600");
  });

  it("has the summary and the rate-limit tables", async () => {
    const html = renderReport(runOf(await resultsFrom()));
    expect(html).toContain("モデルごとの集計");
    expect(html).toMatch(/<tr><th>gpt-6-sol<\/th><td>1<\/td><td>—<\/td><td>—<\/td>/);
    expect(html).toContain("<td>5000</td>");
    expect(html).toContain("<td>799</td>");
  });

  it("is a single file without external resources", async () => {
    const html = renderReport(runOf(await resultsFrom()));
    expect(html).not.toMatch(/<(script|link)\b/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
