import { callCost } from "./bench.ts";
import { estimateCaseTokens } from "./cases.ts";
import type { BenchCase } from "./cases.ts";
import type { ModelPrice, ModelSpec } from "./config.ts";
import { callModel } from "./openai.ts";
import type { CallDeps, CallResult } from "./openai.ts";

/**
 * The load test: keep `concurrency` calls in flight (a new one starts as soon as one ends) for
 * `durationMs`, or, for a burst, start `concurrency` calls at once and nothing after them. The
 * cases are used in turn. Safety stops end the run early: too many 429s, the request cap, or the
 * cost cap. A stop only prevents new calls; those in flight are left to finish and are recorded.
 */

/** Output tokens assumed per call before it has answered (measured: about 300 for gpt-4.1-mini). */
export const ASSUMED_OUTPUT_TOKENS = 300;

export type LoadLimits = {
  readonly maxRequests: number;
  readonly maxCostUsd: number;
  /** Stop after this many 429s in a row (in the order the calls finished). */
  readonly max429InARow: number;
  /** Stop when at least this share of the finished calls are 429 ... */
  readonly max429Ratio: number;
  /** ... once at least this many calls have finished. */
  readonly ratioMinSample: number;
};

export type LoadPlan = {
  readonly cases: readonly BenchCase[];
  readonly model: ModelSpec & { readonly price: ModelPrice };
  readonly concurrency: number;
  /** null for a burst: one round of `concurrency` calls started together. */
  readonly durationMs: number | null;
  readonly timeoutMs: number;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly limits: LoadLimits;
};

export type LoadCall = CallResult & {
  readonly seq: number;
  readonly caseId: string;
  /** Milliseconds since the run started. */
  readonly startMs: number;
  readonly endMs: number;
  readonly costUsd: number | null;
};

export type StopReason =
  | "duration"
  | "burst-done"
  | "max-requests"
  | "max-cost"
  | "429-in-a-row"
  | "429-ratio";

export type LoadOutcome = {
  readonly calls: readonly LoadCall[];
  readonly stopReason: StopReason;
  /** From the start to the end of the last call. */
  readonly wallMs: number;
};

/** The cost a call is expected to have before it answers: its input plus the assumed output. */
export const estimateCallCost = (benchCase: BenchCase, price: ModelPrice): number =>
  (estimateCaseTokens(benchCase) * price.input + ASSUMED_OUTPUT_TOKENS * price.output) / 1_000_000;

export const isRateLimited = (call: CallResult): boolean => call.status === 429;

/** Whether the 429s seen so far call for a stop. */
export const rateLimitStop = (
  finished: readonly CallResult[],
  limits: LoadLimits,
): "429-in-a-row" | "429-ratio" | null => {
  let inARow = 0;
  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const call = finished[index];
    if (call === undefined || !isRateLimited(call)) break;
    inARow += 1;
  }
  if (inARow >= limits.max429InARow) return "429-in-a-row";
  if (finished.length < limits.ratioMinSample) return null;
  const limited = finished.filter(isRateLimited).length;
  return limited / finished.length >= limits.max429Ratio ? "429-ratio" : null;
};

type State = {
  launched: number;
  /** Cost counted for every launched call: the actual one once known, the estimate until then. */
  committedUsd: number;
  stop: StopReason | null;
  readonly finished: LoadCall[];
};

const nextCase = (plan: LoadPlan, seq: number): BenchCase | undefined =>
  plan.cases[seq % plan.cases.length];

/** Why the next call must not start, or null when it may. */
const blockNext = (
  plan: LoadPlan,
  state: State,
  elapsedMs: number,
  estimate: number,
): StopReason | null => {
  if (state.stop !== null) return state.stop;
  if (plan.durationMs === null && state.launched >= plan.concurrency) return "burst-done";
  if (plan.durationMs !== null && elapsedMs >= plan.durationMs) return "duration";
  if (state.launched >= plan.limits.maxRequests) return "max-requests";
  if (state.committedUsd + estimate > plan.limits.maxCostUsd) return "max-cost";
  return null;
};

export const runLoad = async (
  plan: LoadPlan,
  deps: CallDeps,
  onCall?: (call: LoadCall) => void,
): Promise<LoadOutcome> => {
  const startedAt = deps.clock.now();
  const elapsed = (): number => deps.clock.now() - startedAt;
  const state: State = { launched: 0, committedUsd: 0, stop: null, finished: [] };

  const runOne = async (seq: number, benchCase: BenchCase, estimate: number): Promise<void> => {
    const startMs = elapsed();
    const result = await callModel(
      {
        baseUrl: plan.baseUrl,
        apiKey: plan.apiKey,
        model: plan.model,
        messages: benchCase.messages,
        timeoutMs: plan.timeoutMs,
      },
      deps,
    );
    const costUsd = callCost(result, plan.model.price);
    if (costUsd !== null) state.committedUsd += costUsd - estimate;
    const call: LoadCall = {
      ...result,
      seq,
      caseId: benchCase.id,
      startMs,
      endMs: elapsed(),
      costUsd,
    };
    state.finished.push(call);
    state.stop ??= rateLimitStop(state.finished, plan.limits);
    onCall?.(call);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const seq = state.launched;
      const benchCase = nextCase(plan, seq);
      if (benchCase === undefined) return;
      const estimate = estimateCallCost(benchCase, plan.model.price);
      const blocked = blockNext(plan, state, elapsed(), estimate);
      if (blocked !== null) {
        state.stop ??= blocked;
        return;
      }
      state.launched += 1;
      state.committedUsd += estimate;
      await runOne(seq, benchCase, estimate);
    }
  };

  await Promise.all(Array.from({ length: plan.concurrency }, worker));
  const calls = [...state.finished].sort((a, b) => a.seq - b.seq);
  return {
    calls,
    stopReason: state.stop ?? (plan.durationMs === null ? "burst-done" : "duration"),
    wallMs: elapsed(),
  };
};
