import { isCutOffBeforeProductionTimeout, isOverProductionTimeout } from "./bench.ts";
import type { LoadCall } from "./load.ts";

/** Counts, latencies, throughput and the lowest remaining rate limit, overall and per second. */

/** Nearest-rank percentile (p in 0..100); null for no values. */
export const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
};

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const tokensOf = (call: LoadCall): number =>
  call.usage === null ? 0 : call.usage.promptTokens + call.usage.completionTokens;

/** "429 rate_limit_exceeded / requests", "500 server_error", "timeout", ... */
export const outcomeKey = (call: LoadCall): string => {
  if (call.error === null) return `${String(call.status)} ok`;
  if (call.error.kind === "http_error") return `${String(call.status)} ${call.error.message}`;
  return call.error.kind;
};

const countBy = (calls: readonly LoadCall[], key: (call: LoadCall) => string) => {
  const counts: Record<string, number> = {};
  for (const call of calls) counts[key(call)] = (counts[key(call)] ?? 0) + 1;
  return counts;
};

/** The lowest value of a numeric rate-limit header seen; null when it never came. */
const minHeader = (
  calls: readonly LoadCall[],
  name: "x-ratelimit-remaining-requests" | "x-ratelimit-remaining-tokens",
): number | null => {
  const values = calls.flatMap((call) => {
    const value = Number(call.rateLimit[name]);
    return call.rateLimit[name] === undefined || !Number.isFinite(value) ? [] : [value];
  });
  return values.length === 0 ? null : Math.min(...values);
};

/** A count over `ms` milliseconds, as a rate per minute. */
const perMinute = (count: number, ms: number): number => (ms <= 0 ? 0 : (count * 60_000) / ms);

export type LoadSummary = ReturnType<typeof summarizeCalls>;

/** Latencies count successful calls only, as in the comparison: an error says nothing of speed. */
export const summarizeCalls = (calls: readonly LoadCall[], windowMs: number) => {
  const succeeded = calls.filter((call) => call.error === null);
  const latencies = succeeded.map((call) => call.elapsedMs);
  const known = calls.flatMap((call) => (call.costUsd === null ? [] : [call.costUsd]));
  const costLowerBoundUsd = sum(known);
  return {
    completed: calls.length,
    succeeded: succeeded.length,
    rateLimited: calls.filter((call) => call.status === 429).length,
    overProductionTimeout: calls.filter(isOverProductionTimeout).length,
    cutOffBeforeProductionTimeout: calls.filter(isCutOffBeforeProductionTimeout).length,
    network: calls.filter((call) => call.error?.kind === "network").length,
    outcomes: countBy(calls, outcomeKey),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    maxMs: latencies.length === 0 ? null : Math.max(...latencies),
    rpm: perMinute(calls.length, windowMs),
    tpm: perMinute(sum(calls.map(tokensOf)), windowMs),
    tokens: sum(calls.map(tokensOf)),
    minRemainingRequests: minHeader(calls, "x-ratelimit-remaining-requests"),
    minRemainingTokens: minHeader(calls, "x-ratelimit-remaining-tokens"),
    totalCostUsd: known.length === calls.length ? costLowerBoundUsd : null,
    costLowerBoundUsd,
  };
};

export type SecondRow = LoadSummary & { readonly second: number; readonly started: number };

/**
 * One row per second of the run, by when the calls finished (`started` counts the calls that
 * began in that second). RPM and TPM are that second's numbers times 60.
 */
export const perSecond = (calls: readonly LoadCall[], wallMs: number): SecondRow[] => {
  const seconds = Math.floor(Math.max(0, wallMs) / 1000) + 1;
  return Array.from({ length: seconds }, (_, second) => {
    const inSecond = calls.filter((call) => Math.floor(call.endMs / 1000) === second);
    const started = calls.filter((call) => Math.floor(call.startMs / 1000) === second).length;
    return { ...summarizeCalls(inSecond, 1000), second, started };
  });
};
