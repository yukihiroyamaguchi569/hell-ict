import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planJobs, runJobs, summarize } from "./bench.ts";
import type { JobResult } from "./bench.ts";
import { parseCases } from "./cases.ts";
import { dryRunLines, parseCliArgs, providersOf, resolveOutDir, USAGE } from "./cli.ts";
import { makePrivateDir, writePrivateFile } from "./files.ts";
import { readEndpoints } from "./providers.ts";
import type { Endpoint, ProviderName } from "./providers.ts";
import { renderReport } from "./report.ts";
import type { BenchRun } from "./report.ts";

/**
 * Entry point: `node scripts/ai-bench/main.ts --cases <file>` (or `pnpm ai-bench`). Everything
 * with side effects (files, environment, network, stdout) lives here; the rest is testable.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const progressLine = (result: JobResult, done: number, total: number): string => {
  const status = result.error === null ? `HTTP ${String(result.status)}` : result.error.kind;
  const late = result.overProductionTimeout
    ? " (20s+)"
    : result.cutOffBeforeProductionTimeout
      ? " (cut off before 20s)"
      : "";
  return `[${String(done)}/${String(total)}] ${result.model} (${result.provider}) ${result.caseId} #${String(result.round)}: ${String(result.elapsedMs)} ms, ${status}${late}`;
};

const main = async (): Promise<void> => {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const raw: unknown = JSON.parse(await readFile(options.casesPath, "utf8"));
  const cases = parseCases(raw);
  if (options.dryRun) {
    for (const line of dryRunLines(cases, options)) console.log(line);
    return;
  }
  const endpoints = readEndpoints(process.env, providersOf(options.models));
  const endpointFor = (provider: ProviderName): Endpoint => {
    const endpoint = endpoints.get(provider);
    // readEndpoints covered every provider of options.models, the only models the jobs use.
    if (endpoint === undefined) throw new Error(`no endpoint for ${provider}`);
    return endpoint;
  };
  const startedAt = new Date();
  const outDir = resolveOutDir(options.out, {
    repoRoot: REPO_ROOT,
    tmpDir: os.tmpdir(),
    stamp: startedAt.toISOString().replace(/[:.]/g, "-"),
  });
  const jobs = planJobs(cases, options.models, options.repeat);
  const results = await runJobs(
    jobs,
    cases,
    {
      endpointFor,
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
      onResult: (result, done, total) => {
        console.error(progressLine(result, done, total));
      },
    },
    { fetch: (url, init) => fetch(url, init), clock: { now: () => performance.now() } },
  );
  const run: BenchRun = {
    startedAt: startedAt.toISOString(),
    models: options.models.map(({ name, provider }) => ({ name, provider })),
    repeat: options.repeat,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    cases,
    results,
    summaries: summarize(options.models, results),
  };
  await makePrivateDir(outDir);
  await writePrivateFile(path.join(outDir, "bench.json"), JSON.stringify(run, null, 2));
  await writePrivateFile(path.join(outDir, "report.html"), renderReport(run));
  console.log(`report: ${path.join(outDir, "report.html")}`);
  console.log(`raw data: ${path.join(outDir, "bench.json")}`);
};

main().catch((caught: unknown) => {
  console.error(caught instanceof Error ? caught.message : String(caught));
  console.error("Run with --help for usage.");
  process.exitCode = 1;
});
