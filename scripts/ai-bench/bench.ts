import type { BenchCase } from "./cases.ts";
import { PRODUCTION_TIMEOUT_MS } from "./config.ts";
import type { ModelPrice, ModelSpec } from "./config.ts";
import { callModel } from "./openai.ts";
import type { CallDeps, CallResult, RateLimitHeaders, Usage } from "./openai.ts";

/**
 * Which calls to make, in which order, and what they add up to. The order rotates the models
 * from one case to the next, so no model always goes first (warm connections, a filling rate
 * limit) or always last.
 */

export type Job = {
  readonly caseId: string;
  readonly model: ModelSpec;
  /** 1-based. */
  readonly round: number;
};

export const planJobs = (
  cases: readonly BenchCase[],
  models: readonly ModelSpec[],
  repeat: number,
): readonly Job[] => {
  const rotated = (turn: number): readonly ModelSpec[] =>
    models.map((_, slot) => models[(turn + slot) % models.length]).filter((m) => m !== undefined);
  return Array.from({ length: repeat }, (_, index) => index + 1).flatMap((round) =>
    cases.flatMap((benchCase, caseIndex) =>
      rotated((round - 1) * cases.length + caseIndex).map((model) => ({
        caseId: benchCase.id,
        model,
        round,
      })),
    ),
  );
};

export type JobResult = CallResult & {
  readonly caseId: string;
  readonly model: string;
  readonly round: number;
  /** Slower than the Worker waits: the participant would have seen a failure. */
  readonly overProductionTimeout: boolean;
  /**
   * Given up on (`--timeout-ms`) before the Worker's limit: whether production would have timed
   * out cannot be told, so it is counted apart from both the fast and the late calls.
   */
  readonly cutOffBeforeProductionTimeout: boolean;
  /** USD; null when it cannot be known (see `callCost`). */
  readonly costUsd: number | null;
  /** Order in which the calls finished, for "the last rate limit seen". */
  readonly finishedOrder: number;
};

export const costOf = (usage: Usage | null, price: ModelPrice | null): number | null => {
  if (usage === null || price === null) return null;
  return (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
};

/**
 * What a call cost. A rejected request (an HTTP error came back) is not billed: 0. A reply
 * without usage, or a call that timed out or lost its connection after the request went out,
 * may have been billed: unknown (null), never guessed as 0.
 */
export const callCost = (call: CallResult, price: ModelPrice | null): number | null => {
  if (call.usage === null && call.error?.kind === "http_error") return 0;
  return costOf(call.usage, price);
};

/** Took longer than the Worker waits. A call cut off at the very limit counts as late too. */
export const isOverProductionTimeout = (result: CallResult): boolean =>
  result.elapsedMs > PRODUCTION_TIMEOUT_MS ||
  (result.error?.kind === "timeout" && result.elapsedMs >= PRODUCTION_TIMEOUT_MS);

export const isCutOffBeforeProductionTimeout = (result: CallResult): boolean =>
  result.error?.kind === "timeout" && result.elapsedMs < PRODUCTION_TIMEOUT_MS;

export type RunOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly onResult?: (result: JobResult, done: number, total: number) => void;
};

/** Runs the jobs with at most `concurrency` calls in flight, keeping the results in job order. */
export const runJobs = async (
  jobs: readonly Job[],
  cases: readonly BenchCase[],
  options: RunOptions,
  deps: CallDeps,
): Promise<readonly JobResult[]> => {
  const messagesOf = new Map(cases.map((benchCase) => [benchCase.id, benchCase.messages]));
  const results: (JobResult | undefined)[] = jobs.map(() => undefined);
  let next = 0;
  let finished = 0;
  const runOne = async (job: Job, index: number): Promise<void> => {
    const call = await callModel(
      {
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: job.model,
        messages: messagesOf.get(job.caseId) ?? [],
        timeoutMs: options.timeoutMs,
      },
      deps,
    );
    finished += 1;
    const result: JobResult = {
      ...call,
      caseId: job.caseId,
      model: job.model.name,
      round: job.round,
      overProductionTimeout: isOverProductionTimeout(call),
      cutOffBeforeProductionTimeout: isCutOffBeforeProductionTimeout(call),
      costUsd: callCost(call, job.model.price),
      finishedOrder: finished,
    };
    results[index] = result;
    options.onResult?.(result, finished, jobs.length);
  };
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index];
      if (job !== undefined) await runOne(job, index);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency, jobs.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results.filter((result): result is JobResult => result !== undefined);
};

export type ModelSummary = {
  readonly model: string;
  readonly calls: number;
  readonly medianMs: number | null;
  readonly maxMs: number | null;
  /** null when any call's cost is unknown; `costLowerBoundUsd` then holds what is known. */
  readonly totalCostUsd: number | null;
  readonly costLowerBoundUsd: number;
  readonly overProductionTimeout: number;
  readonly cutOffBeforeProductionTimeout: number;
  readonly errors: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  /** Replies that came without usable token counts: the token sums leave them out. */
  readonly usageUnknown: number;
  /** The rate-limit headers of the call that finished last among those that returned any. */
  readonly rateLimit: RateLimitHeaders;
};

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? 0) + upper) / 2;
};

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * Unknown as soon as one call's cost is unknown: a sum that silently skipped it would read as the
 * full cost. The known part is kept as a lower bound.
 */
const totalCost = (
  results: readonly JobResult[],
): { totalCostUsd: number | null; costLowerBoundUsd: number } => {
  const known = results.flatMap((result) => (result.costUsd === null ? [] : [result.costUsd]));
  const costLowerBoundUsd = sum(known);
  return {
    totalCostUsd: known.length === results.length ? costLowerBoundUsd : null,
    costLowerBoundUsd,
  };
};

const lastRateLimit = (results: readonly JobResult[]): RateLimitHeaders => {
  const withHeaders = results
    .filter((result) => Object.keys(result.rateLimit).length > 0)
    .sort((a, b) => a.finishedOrder - b.finishedOrder);
  return withHeaders.at(-1)?.rateLimit ?? {};
};

/**
 * Durations count successful calls only: a timeout or an instant 4xx would say nothing about
 * how fast the model answers. Errors and timeouts have their own columns.
 */
export const summarizeModel = (model: string, all: readonly JobResult[]): ModelSummary => {
  const results = all.filter((result) => result.model === model);
  const succeeded = results.filter((result) => result.error === null);
  const durations = succeeded.map((result) => result.elapsedMs);
  const usages = results.flatMap((result) => (result.usage === null ? [] : [result.usage]));
  return {
    model,
    calls: results.length,
    medianMs: median(durations),
    maxMs: durations.length === 0 ? null : Math.max(...durations),
    ...totalCost(results),
    overProductionTimeout: results.filter((result) => result.overProductionTimeout).length,
    cutOffBeforeProductionTimeout: results.filter((result) => result.cutOffBeforeProductionTimeout)
      .length,
    errors: results.length - succeeded.length,
    promptTokens: sum(usages.map((usage) => usage.promptTokens)),
    completionTokens: sum(usages.map((usage) => usage.completionTokens)),
    reasoningTokens: sum(usages.map((usage) => usage.reasoningTokens)),
    usageUnknown: succeeded.filter((result) => result.usage === null).length,
    rateLimit: lastRateLimit(results),
  };
};

export const summarize = (
  models: readonly ModelSpec[],
  results: readonly JobResult[],
): readonly ModelSummary[] => models.map((model) => summarizeModel(model.name, results));
