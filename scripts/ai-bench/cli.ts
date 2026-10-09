import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { estimateCaseTokens } from "./cases.ts";
import type { BenchCase } from "./cases.ts";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONCURRENCY,
  DEFAULT_MODEL_NAMES,
  DEFAULT_REPEAT,
  DEFAULT_TIMEOUT_MS,
  modelSpecFor,
} from "./config.ts";
import type { ModelSpec } from "./config.ts";
import { formatUsd } from "./report.ts";

/** The command line, the key and the output place: everything decided before the first call. */

export const USAGE = `Usage: pnpm ai-bench --cases <cases.json> [options]

  --cases <file>        case file (JSON array of {id, stage, label, messages})
  --models <a,b,...>    models to compare (default: ${DEFAULT_MODEL_NAMES.join(",")})
  --repeat <n>          calls per case and model (default: ${String(DEFAULT_REPEAT)})
  --concurrency <n>     calls in flight at once (default: ${String(DEFAULT_CONCURRENCY)})
  --timeout-ms <n>      give up on a call after this long (default: ${String(DEFAULT_TIMEOUT_MS)})
  --out <dir>           where to write bench.json and report.html (default: under $TMPDIR).
                        Must be outside this repository: the output holds the real scenario.
  --dry-run             show what would be sent, without the API key and without calling

The API key is read from the environment variable OPENAI_API_KEY only.
OPENAI_BASE_URL overrides the endpoint (default: ${DEFAULT_BASE_URL}).`;

export type CliOptions = {
  readonly casesPath: string;
  readonly models: readonly ModelSpec[];
  readonly repeat: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly out: string | null;
  readonly dryRun: boolean;
  readonly help: boolean;
};

const positiveInteger = (raw: string | undefined, name: string, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer (got "${raw}")`);
  }
  return value;
};

const modelList = (raw: string | undefined): readonly ModelSpec[] => {
  const names = (raw ?? DEFAULT_MODEL_NAMES.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) throw new Error("--models must name at least one model");
  return [...new Set(names)].map(modelSpecFor);
};

export const parseCliArgs = (argv: readonly string[]): CliOptions => {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      cases: { type: "string" },
      models: { type: "string" },
      repeat: { type: "string" },
      concurrency: { type: "string" },
      "timeout-ms": { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (!values.help && values.cases === undefined) throw new Error("--cases is required");
  return {
    casesPath: values.cases ?? "",
    models: modelList(values.models),
    repeat: positiveInteger(values.repeat, "repeat", DEFAULT_REPEAT),
    concurrency: positiveInteger(values.concurrency, "concurrency", DEFAULT_CONCURRENCY),
    timeoutMs: positiveInteger(values["timeout-ms"], "timeout-ms", DEFAULT_TIMEOUT_MS),
    out: values.out ?? null,
    dryRun: values["dry-run"],
    help: values.help,
  };
};

/** The key comes from the environment only, so it never lands in shell history or a file. */
export const readApiKey = (env: Readonly<Record<string, string | undefined>>): string => {
  const key = env.OPENAI_API_KEY?.trim() ?? "";
  if (key === "") {
    throw new Error(
      "OPENAI_API_KEY is not set. Run `read -s OPENAI_API_KEY; export OPENAI_API_KEY` first " +
        "(or use --dry-run to check the cases without a key).",
    );
  }
  return key;
};

export const baseUrlOf = (env: Readonly<Record<string, string | undefined>>): string =>
  (env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");

const isInside = (dir: string, root: string): boolean => {
  const relative = path.relative(root, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const exists = (target: string): boolean => {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * The path with every symbolic link resolved. A path that does not exist yet is resolved through
 * its nearest existing ancestor. A dangling link throws (realpath fails), so it is refused too:
 * writing through it could land anywhere.
 */
export const realPathOf = (target: string): string => {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!exists(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), ...rest);
};

/**
 * Refuses a path inside the repository, where the real scenario could get committed. Both sides
 * are compared after resolving symbolic links, so a link to the repository does not slip through.
 */
export const assertOutsideRepo = (target: string, repoRoot: string): void => {
  let real: string;
  try {
    real = realPathOf(target);
  } catch {
    throw new Error(`cannot resolve the output path (${path.resolve(target)})`);
  }
  if (isInside(real, realPathOf(repoRoot))) {
    throw new Error(`the output must be outside the repository (${path.resolve(target)})`);
  }
};

/**
 * Where the output goes. It holds the real system prompts and the participants' text, so it
 * must not land inside the (public) repository, where it could be committed.
 */
export const resolveOutDir = (
  out: string | null,
  context: { readonly repoRoot: string; readonly tmpDir: string; readonly stamp: string },
): string => {
  const dir = path.resolve(out ?? path.join(context.tmpDir, "hell-ict-ai-bench", context.stamp));
  assertOutsideRepo(dir, context.repoRoot);
  return dir;
};

/** What a dry run prints: per case, the size of what each model would get. */
export const dryRunLines = (cases: readonly BenchCase[], options: CliOptions): string[] => {
  const lines = options.models.map(
    (model) => `model ${model.name} params ${JSON.stringify(model.params)}`,
  );
  let totalTokens = 0;
  for (const benchCase of cases) {
    const chars = benchCase.messages.reduce((sum, message) => sum + message.content.length, 0);
    const tokens = estimateCaseTokens(benchCase);
    totalTokens += tokens;
    lines.push(
      `${benchCase.id} [${benchCase.stage}] ${benchCase.label}: ${String(benchCase.messages.length)} messages, ${String(chars)} chars, ~${String(tokens)} tokens`,
    );
  }
  const calls = cases.length * options.repeat;
  lines.push(
    `${String(calls)} calls per model, ${String(calls * options.models.length)} in all, ~${String(totalTokens * options.repeat)} input tokens per model`,
  );
  for (const model of options.models) {
    const inputUsd =
      model.price === null ? null : (totalTokens * options.repeat * model.price.input) / 1_000_000;
    lines.push(`${model.name}: input ~${formatUsd(inputUsd)} (output not included)`);
  }
  return lines;
};
