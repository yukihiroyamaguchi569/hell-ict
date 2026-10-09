import { describe, expect, it } from "vitest";

import {
  callCost,
  isCutOffBeforeProductionTimeout,
  isOverProductionTimeout,
  summarize,
} from "./bench.ts";
import type { JobResult } from "./bench.ts";
import { modelSpecFor } from "./config.ts";
import { callModel } from "./openai.ts";
import type { FetchFn } from "./openai.ts";
import { escapeHtml, formatUsd, renderReport } from "./report.ts";
import type { BenchRun } from "./report.ts";

const KEY = "sk-report-SECRET-987";
const MODELS = ["gpt-4o", "gpt-6-sol"].map((name) => modelSpecFor(name));
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
        provider: model.provider,
        round: 1,
        overProductionTimeout: isOverProductionTimeout(slow),
        cutOffBeforeProductionTimeout: isCutOffBeforeProductionTimeout(slow),
        costUsd: callCost(slow, model.price),
        finishedOrder: index + 1,
      };
    }),
  );
};

const runOf = (results: JobResult[]): BenchRun => ({
  startedAt: "2026-10-10T00:00:00.000Z",
  models: MODELS.map(({ name, provider }) => ({ name, provider })),
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
    expect(html).toContain('<h3>gpt-4o <span class="provider">openai</span></h3>');
    expect(html).toContain('<h3>gpt-6-sol <span class="provider">openai</span></h3>');
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
    expect(html).toMatch(
      /<tr><th>gpt-6-sol<\/th><td>openai<\/td><td>1<\/td><td>—<\/td><td>—<\/td>/,
    );
    expect(html).toContain(
      "<code>x-ratelimit-limit-requests</code> 5000<br><code>x-ratelimit-remaining-tokens</code> 799",
    );
    expect(html).toContain("取れない（ヘッダが返らなかった）");
  });

  it("shows a call cut off before 20 seconds as undetermined, not as a production timeout", async () => {
    const [fast, failed] = await resultsFrom();
    if (fast === undefined || failed === undefined) throw new Error("fixture");
    const cutOff: JobResult = {
      ...failed,
      elapsedMs: 5_000,
      error: { kind: "timeout", message: "no reply within 5000 ms" },
      overProductionTimeout: false,
      cutOffBeforeProductionTimeout: true,
    };
    const html = renderReport(
      runOf([{ ...fast, elapsedMs: 1_000, overProductionTimeout: false }, cutOff]),
    );
    expect(html).toContain("打ち切り（本番での判定不能）");
    expect(html).not.toContain("本番ならタイムアウト（");
    expect(html).toMatch(
      /<tr><th>gpt-6-sol<\/th>(<td>[^<]*<\/td>){9}<td>0<\/td><td>1<\/td><td>1<\/td><\/tr>/,
    );
  });

  it("shows the cost as unknown, not $0, when the usage came back malformed", async () => {
    const model = modelSpecFor("gpt-4o");
    const call = await callModel(
      { baseUrl: "u", apiKey: KEY, model, messages: benchCase.messages, timeoutMs: 1000 },
      {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { content: "応答" } }],
                usage: { prompt_tokens: "1200", completion_tokens: 300 },
              }),
            ),
          ),
        clock: { now: () => 0 },
      },
    );
    const result: JobResult = {
      ...call,
      caseId: benchCase.id,
      model: model.name,
      provider: model.provider,
      round: 1,
      overProductionTimeout: false,
      cutOffBeforeProductionTimeout: false,
      costUsd: callCost(call, model.price),
      finishedOrder: 1,
    };
    const html = renderReport({
      ...runOf([result]),
      models: [{ name: model.name, provider: model.provider }],
      summaries: summarize([model], [result]),
    });
    expect(html).toContain('<pre class="reply">応答</pre>');
    expect(html).toContain("トークン 不明 · 不明");
    expect(html).toContain("不明（下限 $0.00000）");
    expect(html).toMatch(/<tr><th>gpt-4o<\/th>(<td>[^<]*<\/td>){7}<td>1<\/td><td>不明（下限 /);
  });

  it("shows each provider and the rate-limit headers each one gave, or that none can be had", async () => {
    const keys = { gemini: "AIzaReportGeminiKey123", anthropic: "sk-ant-report-SECRET" } as const;
    const models = ["gemini-3.8-flash", "claude-haiku-5-5"].map((name) => modelSpecFor(name));
    const results: JobResult[] = await Promise.all(
      models.map(async (model, index) => {
        const call = await callModel(
          {
            baseUrl: "u",
            apiKey: model.provider === "gemini" ? keys.gemini : keys.anthropic,
            model,
            messages: benchCase.messages,
            timeoutMs: 1000,
          },
          {
            fetch: () =>
              Promise.resolve(
                new Response(
                  JSON.stringify({
                    choices: [{ message: { content: `from ${model.name}` } }],
                    usage: { prompt_tokens: 10, completion_tokens: 5 },
                  }),
                  {
                    headers: {
                      "x-ratelimit-remaining-requests": "41",
                      "anthropic-ratelimit-output-tokens-remaining": "2000000",
                      "x-goog-something": "ignored",
                    },
                  },
                ),
              ),
            clock: { now: () => 0 },
          },
        );
        return {
          ...call,
          caseId: benchCase.id,
          model: model.name,
          provider: model.provider,
          round: 1,
          overProductionTimeout: false,
          cutOffBeforeProductionTimeout: false,
          costUsd: callCost(call, model.price),
          finishedOrder: index + 1,
        };
      }),
    );
    const html = renderReport({
      ...runOf(results),
      models: models.map(({ name, provider }) => ({ name, provider })),
      summaries: summarize(models, results),
    });
    expect(html).toContain("gemini-3.8-flash（gemini）, claude-haiku-5-5（anthropic）");
    expect(html).toContain('<h3>claude-haiku-5-5 <span class="provider">anthropic</span></h3>');
    expect(html).toMatch(/<tr><th>gemini-3.8-flash<\/th><td>gemini<\/td><td>1<\/td>/);
    // Gemini documents no rate-limit header: whatever came is not read.
    expect(html).toContain(
      '<tr><th>gemini-3.8-flash</th><td>gemini</td><td class="headers">取れない（このプロバイダは rate limit のヘッダを返さない）</td></tr>',
    );
    expect(html).toContain(
      "<code>x-ratelimit-remaining-requests</code> 41<br><code>anthropic-ratelimit-output-tokens-remaining</code> 2000000",
    );
    expect(html).not.toContain("x-goog-something");
    for (const key of Object.values(keys)) expect(html).not.toContain(key);
  });

  it("is a single file without external resources", async () => {
    const html = renderReport(runOf(await resultsFrom()));
    expect(html).not.toMatch(/<(script|link)\b/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
