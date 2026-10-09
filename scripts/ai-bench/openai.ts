import type { BenchMessage } from "./cases.ts";
import type { ModelSpec } from "./config.ts";
import { PROVIDERS } from "./providers.ts";

/**
 * One call to an OpenAI-compatible Chat Completions endpoint (OpenAI, Gemini or Anthropic),
 * measured. Never throws: every failure (HTTP error, timeout, lost
 * connection, a body of the wrong shape) is recorded in the result so the bench keeps going.
 * The API key goes into the request header only and never into the result.
 */

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type Clock = { readonly now: () => number };

export type CallRequest = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: ModelSpec;
  readonly messages: readonly BenchMessage[];
  readonly timeoutMs: number;
};

export type CallDeps = { readonly fetch: FetchFn; readonly clock: Clock };

/** Header name (lower case) to value, for the provider's rate-limit headers that came back. */
export type RateLimitHeaders = Readonly<Record<string, string>>;

export type Usage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
};

export type CallErrorKind = "http_error" | "timeout" | "network" | "invalid_response";

export type CallError = {
  readonly kind: CallErrorKind;
  /** OpenAI's error code/type or our own description, with anything key-like masked. */
  readonly message: string;
};

export type CallResult = {
  readonly status: number | null;
  readonly elapsedMs: number;
  readonly text: string | null;
  readonly usage: Usage | null;
  readonly error: CallError | null;
  readonly rateLimit: RateLimitHeaders;
};

export const readRateLimitHeaders = (
  headers: Headers,
  names: readonly string[],
): RateLimitHeaders => {
  const found: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) found[name] = value;
  }
  return found;
};

/**
 * Masks the key itself and anything shaped like a key: OpenAI's and Anthropic's start with `sk-`
 * (error bodies quote a masked one), Google's with `AIza`.
 */
export const redactSecrets = (text: string, apiKey: string): string => {
  const withoutKey = apiKey === "" ? text : text.split(apiKey).join("[REDACTED]");
  return withoutKey
    .replace(/sk-[A-Za-z0-9_\-*]+/g, "[REDACTED]")
    .replace(/AIza[\w-]+/g, "[REDACTED]");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** `completion_tokens_details.reasoning_tokens`: absent is 0 (older models omit it), malformed is null. */
const reasoningTokensOf = (details: unknown): number | null => {
  if (details === undefined || details === null) return 0;
  if (!isRecord(details)) return null;
  const { reasoning_tokens: reasoning } = details;
  if (reasoning === undefined || reasoning === null) return 0;
  return isTokenCount(reasoning) ? reasoning : null;
};

/**
 * Output tokens that `total_tokens` counts but `completion_tokens` leaves out (an endpoint that
 * reports its thinking apart from the reply): 0 when the total is absent or adds up, null when it
 * is malformed or smaller than its parts.
 */
const unreportedOutputOf = (total: unknown, counted: number): number | null => {
  if (total === undefined || total === null) return 0;
  if (!isTokenCount(total) || total < counted) return null;
  return total - counted;
};

/**
 * The token counts, or null when they are missing or malformed. Never guessed as 0: a missing
 * count would make the tokens and the cost look smaller than they were. Tokens in
 * `total_tokens` beyond prompt + completion are output that was billed but not reported as such
 * (thinking): they are added to the completion and counted as reasoning.
 */
export const parseUsage = (value: unknown): Usage | null => {
  if (!isRecord(value)) return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = value;
  const reasoningTokens = reasoningTokensOf(value.completion_tokens_details);
  if (!isTokenCount(promptTokens) || !isTokenCount(completionTokens) || reasoningTokens === null) {
    return null;
  }
  const unreported = unreportedOutputOf(value.total_tokens, promptTokens + completionTokens);
  if (unreported === null) return null;
  return {
    promptTokens,
    completionTokens: completionTokens + unreported,
    reasoningTokens: reasoningTokens + unreported,
  };
};

/** The reply text of a 200 body, or why it is unusable (a refusal is reported as such). */
export const parseCompletion = (
  body: unknown,
): { ok: true; text: string; usage: Usage | null } | { ok: false; message: string } => {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return { ok: false, message: "no choices in the response" };
  }
  const first: unknown = body.choices[0];
  const message = isRecord(first) ? first.message : undefined;
  if (!isRecord(message)) return { ok: false, message: "no message in the first choice" };
  if (typeof message.content === "string") {
    return { ok: true, text: message.content, usage: parseUsage(body.usage) };
  }
  if (typeof message.refusal === "string") return { ok: false, message: "refusal" };
  return { ok: false, message: "no content in the message" };
};

const errorPart = (part: unknown): string[] => {
  if (typeof part === "string" && part !== "") return [part];
  return typeof part === "number" && Number.isFinite(part) ? [String(part)] : [];
};

/**
 * The error's code, type and status, never its free-text message (it can quote the request).
 * OpenAI and Anthropic send `{ error: { code, type } }`; Gemini's native errors are
 * `{ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }`, and may come wrapped in an array.
 */
export const describeErrorBody = (body: unknown): string => {
  const outer: unknown = Array.isArray(body) ? body[0] : body;
  const error = isRecord(outer) ? outer.error : undefined;
  if (!isRecord(error)) return "no error body";
  const parts = [error.code, error.type, error.status].flatMap(errorPart);
  return parts.length === 0 ? "no error code" : parts.join(" / ");
};

const parseJson = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
};

export const requestBody = (model: ModelSpec, messages: readonly BenchMessage[]): string =>
  JSON.stringify({
    model: model.name,
    messages: messages.map(({ role, content }) => ({ role, content })),
    ...model.params,
  });

type Outcome = Omit<CallResult, "elapsedMs" | "rateLimit">;

const failure = (status: number | null, kind: CallErrorKind, message: string): Outcome => ({
  status,
  text: null,
  usage: null,
  error: { kind, message },
});

const outcomeOfBody = (response: Response, text: string): Outcome => {
  const body = parseJson(text);
  if (!response.ok) return failure(response.status, "http_error", describeErrorBody(body));
  if (body === undefined) return failure(response.status, "invalid_response", "body is not JSON");
  const parsed = parseCompletion(body);
  if (!parsed.ok) return failure(response.status, "invalid_response", parsed.message);
  return { status: response.status, text: parsed.text, usage: parsed.usage, error: null };
};

export const callModel = async (request: CallRequest, deps: CallDeps): Promise<CallResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs);
  const startedAt = deps.clock.now();
  let rateLimit: RateLimitHeaders = {};
  let status: number | null = null;
  let outcome: Outcome;
  try {
    const response = await deps.fetch(`${request.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      body: requestBody(request.model, request.messages),
      signal: controller.signal,
    });
    status = response.status;
    rateLimit = readRateLimitHeaders(
      response.headers,
      PROVIDERS[request.model.provider].rateLimitHeaders,
    );
    outcome = outcomeOfBody(response, await response.text());
  } catch {
    outcome = controller.signal.aborted
      ? failure(status, "timeout", `no reply within ${String(request.timeoutMs)} ms`)
      : failure(status, "network", "connection failed");
  } finally {
    clearTimeout(timer);
  }
  const error =
    outcome.error === null
      ? null
      : { ...outcome.error, message: redactSecrets(outcome.error.message, request.apiKey) };
  return { ...outcome, error, rateLimit, elapsedMs: Math.round(deps.clock.now() - startedAt) };
};
