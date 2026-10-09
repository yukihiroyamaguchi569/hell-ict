import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { parseCases } from "./cases.ts";
import { resolveOutDir } from "./cli.ts";
import { makePrivateDir, writePrivateFile } from "./files.ts";
import { runLoad } from "./load.ts";
import { estimateLines, LOAD_USAGE, parseLoadArgs } from "./load-cli.ts";
import { renderLoadReport } from "./load-report.ts";
import type { LoadRun } from "./load-report.ts";
import { perSecond, summarizeCalls } from "./load-stats.ts";
import { PROVIDERS, readEndpoints } from "./providers.ts";

/**
 * Entry point of the load test: `node scripts/ai-bench/load-main.ts --cases <file>` (or
 * `pnpm ai-bench:load`). Side effects only; the logic is in load*.ts.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const confirm = async (): Promise<boolean> => {
  if (!process.stdin.isTTY) throw new Error("not a terminal: pass --yes to start without asking");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Start? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    prompt.close();
  }
};

const main = async (): Promise<void> => {
  const options = parseLoadArgs(process.argv.slice(2));
  if (options.help) {
    console.log(LOAD_USAGE);
    return;
  }
  const raw: unknown = JSON.parse(await readFile(options.casesPath, "utf8"));
  const cases = parseCases(raw);
  for (const line of estimateLines(cases, options)) console.log(line);
  if (options.dryRun) return;
  const provider = options.model.provider;
  const endpoint = readEndpoints(process.env, [provider]).get(provider);
  // readEndpoints throws unless it has the endpoint of every provider it was given.
  if (endpoint === undefined) throw new Error(`no endpoint for ${provider}`);
  const startedAt = new Date();
  const outDir = resolveOutDir(options.out, {
    repoRoot: REPO_ROOT,
    tmpDir: os.tmpdir(),
    stamp: `load-${startedAt.toISOString().replace(/[:.]/g, "-")}`,
  });
  if (!options.yes && !(await confirm())) {
    console.log("Not started.");
    return;
  }
  let done = 0;
  const outcome = await runLoad(
    {
      cases,
      model: options.model,
      concurrency: options.concurrency,
      durationMs: options.durationMs,
      timeoutMs: options.timeoutMs,
      ...endpoint,
      limits: options.limits,
    },
    { fetch: (url, init) => fetch(url, init), clock: { now: () => performance.now() } },
    (call) => {
      done += 1;
      if (done % 50 === 0 || call.status === 429) {
        console.error(
          `${String(done)} done; #${String(call.seq)} ${String(call.status)} ${String(call.elapsedMs)} ms`,
        );
      }
    },
  );
  const run: LoadRun = {
    startedAt: startedAt.toISOString(),
    model: options.model.name,
    provider,
    concurrency: options.concurrency,
    durationMs: options.durationMs,
    timeoutMs: options.timeoutMs,
    casesCount: cases.length,
    outcome,
    summary: summarizeCalls(outcome.calls, outcome.wallMs, PROVIDERS[provider]),
    seconds: perSecond(outcome.calls, outcome.wallMs, PROVIDERS[provider]),
  };
  await makePrivateDir(outDir);
  // The JSON keeps every call but not the reply texts: the load test is about counts and time.
  const calls = outcome.calls.map((call) => ({ ...call, text: null }));
  await writePrivateFile(
    path.join(outDir, "load.json"),
    JSON.stringify({ ...run, outcome: { ...outcome, calls } }, null, 2),
  );
  await writePrivateFile(path.join(outDir, "load-report.html"), renderLoadReport(run));
  console.log(`stopped: ${outcome.stopReason}; ${String(run.summary.completed)} calls`);
  console.log(`report: ${path.join(outDir, "load-report.html")}`);
  console.log(`raw data: ${path.join(outDir, "load.json")}`);
};

main().catch((caught: unknown) => {
  console.error(caught instanceof Error ? caught.message : String(caught));
  console.error("Run with --help for usage.");
  process.exitCode = 1;
});
