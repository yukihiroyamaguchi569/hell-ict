import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { estimateCaseTokens } from "./cases.ts";
import type { BenchCase } from "./cases.ts";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MODEL_NAMES,
  DEFAULT_REPEAT,
  DEFAULT_TIMEOUT_MS,
  KNOWN_MODEL_NAMES,
  modelSpecFor,
} from "./config.ts";
import type { ModelSpec } from "./config.ts";
import { parseProviderName, PROVIDER_NAMES, PROVIDERS } from "./providers.ts";
import type { ProviderName } from "./providers.ts";
import { formatUsd } from "./report.ts";

/** The command line and the output place: everything decided before the first call. */

const providerLines = PROVIDER_NAMES.map((name) => {
  const provider = PROVIDERS[name];
  return `  ${name.padEnd(10)}${provider.keyEnv.padEnd(19)}(${provider.baseUrlEnv} overrides ${provider.baseUrl})`;
}).join("\n");

/** The keys and the providers, shared by the help of the comparison and of the load test. */
export const KEYS_HELP = `Models in config.ts (each is sent to its own provider):
  ${KNOWN_MODEL_NAMES.join(", ")}

API keys are read from the environment only, one per provider in use (never from an argument):
${providerLines}

Enter a key without echoing it or leaving it in the shell history, e.g.:
  read -s OPENAI_API_KEY && export OPENAI_API_KEY
  read -s GEMINI_API_KEY && export GEMINI_API_KEY
  read -s ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY`;

export const USAGE = `Usage: pnpm ai-bench --cases <cases.json> [options]

  --cases <file>        case file (JSON array of {id, stage, label, messages})
  --models <a,b,...>    models to compare, from any providers (default: ${DEFAULT_MODEL_NAMES.join(",")})
  --provider <name>     provider of the models not in config.ts (${PROVIDER_NAMES.join(", ")})
  --repeat <n>          calls per case and model (default: ${String(DEFAULT_REPEAT)})
  --concurrency <n>     calls in flight at once (default: ${String(DEFAULT_CONCURRENCY)})
  --timeout-ms <n>      give up on a call after this long (default: ${String(DEFAULT_TIMEOUT_MS)})
  --out <dir>           where to write bench.json and report.html (default: under $TMPDIR).
                        Must be outside this repository: the output holds the real scenario.
  --dry-run             show what would be sent, without the API keys and without calling

${KEYS_HELP}

Example (three providers side by side):
  pnpm ai-bench --cases cases.json --models gpt-4.1-mini,gemini-3.8-flash,claude-haiku-5-5`;

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

export const providerOption = (raw: string | undefined): ProviderName | null =>
  raw === undefined ? null : parseProviderName(raw);

const modelList = (
  raw: string | undefined,
  provider: ProviderName | null,
): readonly ModelSpec[] => {
  const names = (raw ?? DEFAULT_MODEL_NAMES.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) throw new Error("--models must name at least one model");
  return [...new Set(names)].map((name) => modelSpecFor(name, provider));
};

/** The providers the models need, each once, in the order the models name them. */
export const providersOf = (models: readonly ModelSpec[]): readonly ProviderName[] => [
  ...new Set(models.map((model) => model.provider)),
];

export const parseCliArgs = (argv: readonly string[]): CliOptions => {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      cases: { type: "string" },
      models: { type: "string" },
      provider: { type: "string" },
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
    models: modelList(values.models, providerOption(values.provider)),
    repeat: positiveInteger(values.repeat, "repeat", DEFAULT_REPEAT),
    concurrency: positiveInteger(values.concurrency, "concurrency", DEFAULT_CONCURRENCY),
    timeoutMs: positiveInteger(values["timeout-ms"], "timeout-ms", DEFAULT_TIMEOUT_MS),
    out: values.out ?? null,
    dryRun: values["dry-run"],
    help: values.help,
  };
};

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
    (model) =>
      `model ${model.name} (${model.provider}, key ${PROVIDERS[model.provider].keyEnv}) params ${JSON.stringify(model.params)}`,
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
