import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { modelSpecFor } from "./config.ts";
import { callModel } from "./openai.ts";

/**
 * The comparison run as a process against a local stub of the three providers' endpoints: each
 * model must reach its own provider with its own key, and no key may reach the output.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = {
  OPENAI_API_KEY: "sk-stub-openai-SECRET",
  GEMINI_API_KEY: "AIzaStubGeminiSECRET",
  ANTHROPIC_API_KEY: "sk-ant-stub-SECRET",
};

type Seen = { readonly path: string; readonly authorization: string; readonly body: string };

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** Each provider answers in its own way: Gemini without rate-limit headers, Anthropic with both kinds. */
const HEADERS: Record<string, Record<string, string>> = {
  "/openai": { "x-ratelimit-remaining-requests": "4999" },
  "/gemini": {},
  "/anthropic": {
    "x-ratelimit-remaining-requests": "9998",
    "anthropic-ratelimit-requests-remaining": "9998",
  },
};

describe("main against a stub of the three providers", () => {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void readBody(request).then((body) => {
      const url = request.url ?? "";
      seen.push({ path: url, authorization: request.headers.authorization ?? "", body });
      const prefix = Object.keys(HEADERS).find((key) => url.startsWith(key)) ?? "";
      response.writeHead(200, { "content-type": "application/json", ...HEADERS[prefix] });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: `reply via ${prefix}` } }],
          // Gemini's total counts thinking that completion_tokens leaves out.
          usage:
            prefix === "/gemini"
              ? { prompt_tokens: 100, completion_tokens: 10, total_tokens: 150 }
              : { prompt_tokens: 100, completion_tokens: 10 },
        }),
      );
    });
  });
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("calls each provider with its own key and reports per provider, without a key", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ai-bench-stub-"));
    const casesPath = path.join(dir, "cases.json");
    writeFileSync(
      casesPath,
      JSON.stringify([
        { id: "a", stage: "s4", label: "l", messages: [{ role: "user", content: "q" }] },
      ]),
    );
    const out = path.join(dir, "out");
    const child = spawn(
      process.execPath,
      [
        path.join(HERE, "main.ts"),
        "--cases",
        casesPath,
        "--models",
        "gpt-4.1-mini,gemini-3.8-flash,claude-haiku-5-5",
        "--out",
        out,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          ...KEYS,
          OPENAI_BASE_URL: `${base}/openai/v1`,
          GEMINI_BASE_URL: `${base}/gemini/v1beta/openai/`,
          ANTHROPIC_BASE_URL: `${base}/anthropic/v1`,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code, output).toBe(0);

    expect(seen.map(({ path: url, authorization }) => [url, authorization]).sort()).toEqual([
      ["/anthropic/v1/chat/completions", `Bearer ${KEYS.ANTHROPIC_API_KEY}`],
      ["/gemini/v1beta/openai/chat/completions", `Bearer ${KEYS.GEMINI_API_KEY}`],
      ["/openai/v1/chat/completions", `Bearer ${KEYS.OPENAI_API_KEY}`],
    ]);

    const html = readFileSync(path.join(out, "report.html"), "utf8");
    const json = readFileSync(path.join(out, "bench.json"), "utf8");
    for (const text of [html, json, output]) {
      for (const key of Object.values(KEYS)) expect(text).not.toContain(key);
    }
    expect(html).toContain("reply via /gemini");
    expect(html).toContain("取れない（このプロバイダは rate limit のヘッダを返さない）");
    expect(html).toContain("<code>anthropic-ratelimit-requests-remaining</code> 9998");
    expect(html).toContain("<code>x-ratelimit-remaining-requests</code> 4999");
    const run: unknown = JSON.parse(json);
    expect(run).toMatchObject({
      models: [
        { name: "gpt-4.1-mini", provider: "openai" },
        { name: "gemini-3.8-flash", provider: "gemini" },
        { name: "claude-haiku-5-5", provider: "anthropic" },
      ],
    });
    expect(run).toMatchObject({
      summaries: [
        { provider: "openai", completionTokens: 10, errors: 0 },
        { provider: "gemini", completionTokens: 50, reasoningTokens: 40, errors: 0 },
        { provider: "anthropic", completionTokens: 10, errors: 0 },
      ],
    });
  });
});

describe("callModel with the real fetch against a stub that redirects", () => {
  const reachedOutside: string[] = [];
  const outside = createServer((request: IncomingMessage, response: ServerResponse) => {
    reachedOutside.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "leaked" } }] }));
  });
  let outsideBase = "";
  const redirecting = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    response.writeHead(307, { location: `${outsideBase}/v1/chat/completions` });
    response.end();
  });
  let stubBase = "";

  const listen = async (server: typeof outside): Promise<string> => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return `http://127.0.0.1:${String(address.port)}`;
  };

  beforeAll(async () => {
    outsideBase = await listen(outside);
    stubBase = await listen(redirecting);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => outside.close(() => resolve()));
    await new Promise<void>((resolve) => redirecting.close(() => resolve()));
  });

  it("does not follow a 307: nothing reaches the target and the call is an error", async () => {
    const result = await callModel(
      {
        baseUrl: `${stubBase}/v1`,
        apiKey: KEYS.ANTHROPIC_API_KEY,
        model: modelSpecFor("claude-haiku-5-5"),
        messages: [{ role: "user", content: "the real scenario" }],
        timeoutMs: 5_000,
      },
      { fetch: (url, init) => fetch(url, init), clock: { now: () => 0 } },
    );
    expect(reachedOutside).toEqual([]);
    expect(result).toMatchObject({
      status: 307,
      text: null,
      error: { kind: "http_error", message: "redirect not followed" },
    });
  });
});
