import { parseArgs } from "node:util";

import type { BenchCase } from "./cases.ts";
import { modelSpecFor } from "./config.ts";
import type { ModelPrice, ModelSpec } from "./config.ts";
import { ASSUMED_OUTPUT_TOKENS, estimateCallCost } from "./load.ts";
import type { LoadLimits } from "./load.ts";
import { formatUsd } from "./report.ts";

/** The command line of the load test and the estimate shown before it starts. */

export const LOAD_DEFAULTS = {
  model: "gpt-4.1-mini",
  concurrency: 60,
  durationS: 60,
  timeoutMs: 60_000,
  maxRequests: 1_500,
  maxCostUsd: 5,
  max429InARow: 20,
  max429Ratio: 0.5,
  ratioMinSample: 20,
  /** Measured median of gpt-4.1-mini in the comparison; only used for the estimate. */
  expectedLatencyS: 2.4,
} as const;

export const LOAD_USAGE = `Usage: pnpm ai-bench:load --cases <cases.json> [options]

  --cases <file>            case file (the same as for the comparison); used in turn
  --model <name>            model (default: ${LOAD_DEFAULTS.model}); must have a price in config.ts
  --concurrency <n>         calls kept in flight (default: ${String(LOAD_DEFAULTS.concurrency)})
  --duration-s <n>          how long to keep them in flight (default: ${String(LOAD_DEFAULTS.durationS)})
  --burst                   instead: start <concurrency> calls at once, once, and wait for them
  --timeout-ms <n>          give up on a call after this long (default: ${String(LOAD_DEFAULTS.timeoutMs)})
  --max-requests <n>        never start more calls than this (default: ${String(LOAD_DEFAULTS.maxRequests)})
  --max-cost-usd <x>        stop before the (estimated) cost would pass this (default: ${String(LOAD_DEFAULTS.maxCostUsd)})
  --max-429-in-a-row <n>    stop after this many 429s in a row (default: ${String(LOAD_DEFAULTS.max429InARow)})
  --max-429-ratio <x>       stop when this share of the finished calls are 429, after ${String(LOAD_DEFAULTS.ratioMinSample)} (default: ${String(LOAD_DEFAULTS.max429Ratio)})
  --expected-latency-s <x>  latency assumed for the estimate (default: ${String(LOAD_DEFAULTS.expectedLatencyS)})
  --out <dir>               where to write load.json and load-report.html (default: under $TMPDIR)
  --dry-run                 show the estimate only, without the API key and without calling
  --yes                     start without asking

The API key is read from the environment variable OPENAI_API_KEY only.`;

export type LoadCliOptions = {
  readonly casesPath: string;
  readonly model: ModelSpec & { readonly price: ModelPrice };
  readonly concurrency: number;
  readonly durationMs: number | null;
  readonly timeoutMs: number;
  readonly limits: LoadLimits;
  readonly expectedLatencyS: number;
  readonly out: string | null;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly help: boolean;
};

const positiveNumber = (
  raw: string | undefined,
  name: string,
  fallback: number,
  integer: boolean,
): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `--${name} must be a positive ${integer ? "integer" : "number"} (got "${raw}")`,
    );
  }
  return value;
};

const pricedModel = (name: string): ModelSpec & { readonly price: ModelPrice } => {
  const model = modelSpecFor(name);
  if (model.price === null) {
    throw new Error(`no price for "${name}" in config.ts: the cost cap cannot work without one`);
  }
  return { ...model, price: model.price };
};

const OPTIONS = {
  cases: { type: "string" },
  model: { type: "string" },
  concurrency: { type: "string" },
  "duration-s": { type: "string" },
  burst: { type: "boolean", default: false },
  "timeout-ms": { type: "string" },
  "max-requests": { type: "string" },
  "max-cost-usd": { type: "string" },
  "max-429-in-a-row": { type: "string" },
  "max-429-ratio": { type: "string" },
  "expected-latency-s": { type: "string" },
  out: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  yes: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} as const;

const parseLimits = (values: Partial<Record<keyof typeof OPTIONS, unknown>>): LoadLimits => {
  const text = (key: keyof typeof OPTIONS): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };
  const ratio = positiveNumber(
    text("max-429-ratio"),
    "max-429-ratio",
    LOAD_DEFAULTS.max429Ratio,
    false,
  );
  if (ratio > 1) throw new Error("--max-429-ratio must be at most 1");
  return {
    maxRequests: positiveNumber(
      text("max-requests"),
      "max-requests",
      LOAD_DEFAULTS.maxRequests,
      true,
    ),
    maxCostUsd: positiveNumber(
      text("max-cost-usd"),
      "max-cost-usd",
      LOAD_DEFAULTS.maxCostUsd,
      false,
    ),
    max429InARow: positiveNumber(
      text("max-429-in-a-row"),
      "max-429-in-a-row",
      LOAD_DEFAULTS.max429InARow,
      true,
    ),
    max429Ratio: ratio,
    ratioMinSample: LOAD_DEFAULTS.ratioMinSample,
  };
};

export const parseLoadArgs = (argv: readonly string[]): LoadCliOptions => {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: OPTIONS,
  });
  if (!values.help && values.cases === undefined) throw new Error("--cases is required");
  const durationS = positiveNumber(
    values["duration-s"],
    "duration-s",
    LOAD_DEFAULTS.durationS,
    false,
  );
  return {
    casesPath: values.cases ?? "",
    model: pricedModel(values.model ?? LOAD_DEFAULTS.model),
    concurrency: positiveNumber(values.concurrency, "concurrency", LOAD_DEFAULTS.concurrency, true),
    durationMs: values.burst ? null : durationS * 1000,
    timeoutMs: positiveNumber(values["timeout-ms"], "timeout-ms", LOAD_DEFAULTS.timeoutMs, true),
    limits: parseLimits(values),
    expectedLatencyS: positiveNumber(
      values["expected-latency-s"],
      "expected-latency-s",
      LOAD_DEFAULTS.expectedLatencyS,
      false,
    ),
    out: values.out ?? null,
    dryRun: values["dry-run"],
    yes: values.yes,
    help: values.help,
  };
};

export type LoadEstimate = { readonly requests: number; readonly costUsd: number };

/**
 * Calls and cost the run is expected to reach: concurrency × duration ÷ latency calls (or one
 * round for a burst), held to the request cap and the cost cap. Each call is priced at its case's
 * estimated input plus the assumed output.
 */
export const estimateLoad = (
  cases: readonly BenchCase[],
  options: LoadCliOptions,
): LoadEstimate => {
  const perCall =
    cases.reduce(
      (total, benchCase) => total + estimateCallCost(benchCase, options.model.price),
      0,
    ) / cases.length;
  const byTime =
    options.durationMs === null
      ? options.concurrency
      : Math.ceil((options.concurrency * options.durationMs) / 1000 / options.expectedLatencyS);
  const byCost = perCall > 0 ? Math.floor(options.limits.maxCostUsd / perCall) : byTime;
  const requests = Math.min(byTime, options.limits.maxRequests, byCost);
  return { requests, costUsd: requests * perCall };
};

export const estimateLines = (cases: readonly BenchCase[], options: LoadCliOptions): string[] => {
  const { requests, costUsd } = estimateLoad(cases, options);
  const mode =
    options.durationMs === null
      ? `burst: ${String(options.concurrency)} calls at once`
      : `${String(options.concurrency)} in flight for ${String(options.durationMs / 1000)} s`;
  return [
    `model ${options.model.name}, ${mode}, ${String(cases.length)} cases in turn`,
    `expected: about ${String(requests)} calls, about ${formatUsd(costUsd)} ` +
      `(latency ${String(options.expectedLatencyS)} s, ${String(ASSUMED_OUTPUT_TOKENS)} output tokens per call assumed)`,
    `caps: ${String(options.limits.maxRequests)} calls, ${formatUsd(options.limits.maxCostUsd)}; ` +
      `stops after ${String(options.limits.max429InARow)} 429s in a row or ${String(options.limits.max429Ratio * 100)}% 429s`,
  ];
};
