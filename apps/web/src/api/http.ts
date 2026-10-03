import { httpErrorSchema } from "@hell-ict/domain";
import type { HttpError } from "@hell-ict/domain";
import type { z } from "zod";

import type { Clock, HttpPort, HttpRequest, HttpResponse } from "../ports.js";

/**
 * What one API call came to. Callers branch on `kind` instead of catching: whether to retry
 * depends on which of these it was (a lost connection or a 503 may be resent, a 409 may not).
 * - ok: 2xx and the body passed the schema.
 * - http-error: a non-2xx status. `error` is the Worker's `{message, code?}` when it sent one
 *   (a 404 for an unknown team code is plain text: `null`).
 *   `retryAfterSeconds` is the `Retry-After` of a 429, `null` when absent or unreadable.
 * - network-error: no response (offline, timeout).
 * - invalid-response: 2xx, but the body is not what the API promises. Never used as state.
 */
export type ApiResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly error: HttpError | null;
      readonly retryAfterSeconds: number | null;
    }
  | { readonly kind: "network-error" }
  | { readonly kind: "invalid-response" };

/** Delay-seconds: digits only (`Number` would also take `1e3`, `0x10`, `1.5`, `-1`). */
const DELAY_SECONDS = /^\d+$/;

/** The HTTP date form senders must generate (IMF-fixdate, RFC 9110 §5.6.7). */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Seconds from a `Retry-After` header: delay-seconds as they are, or an HTTP date as the seconds
 * from `nowMs` until it, rounded up (0 when it has passed). A date needs the time now, so without
 * `nowMs` it is `null`. Anything else is `null`, and the notice then leaves the number out.
 */
export const parseRetryAfter = (
  raw: string | null | undefined,
  nowMs: number | null,
): number | null => {
  const trimmed = raw?.trim() ?? "";
  if (DELAY_SECONDS.test(trimmed)) return Number(trimmed);
  if (nowMs === null || !IMF_FIXDATE.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1_000));
};

const toResult = <S extends z.ZodType>(
  response: HttpResponse,
  schema: S,
  clock: Clock | undefined,
): ApiResult<z.output<S>> => {
  if (response.status < 200 || response.status >= 300) {
    const parsed = httpErrorSchema.safeParse(response.body);
    return {
      kind: "http-error",
      status: response.status,
      error: parsed.success ? parsed.data : null,
      retryAfterSeconds: parseRetryAfter(
        response.retryAfter,
        clock === undefined ? null : clock.now().getTime(),
      ),
    };
  }
  const parsed = schema.safeParse(response.body);
  return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "invalid-response" };
};

/**
 * Sends one request and checks the answer against `schema`. Never throws. `clock` is needed only
 * to read a `Retry-After` given as a date; without it such a date reads as `null`.
 */
export const requestJson = async <S extends z.ZodType>(
  http: HttpPort,
  request: HttpRequest,
  schema: S,
  clock?: Clock,
): Promise<ApiResult<z.output<S>>> => {
  let response: HttpResponse;
  try {
    response = await http.send(request);
  } catch {
    return { kind: "network-error" };
  }
  return toResult(response, schema, clock);
};

export const getJson = <S extends z.ZodType>(
  http: HttpPort,
  path: string,
  schema: S,
): Promise<ApiResult<z.output<S>>> => requestJson(http, { method: "GET", path }, schema);

export const postJson = <S extends z.ZodType>(
  http: HttpPort,
  path: string,
  body: unknown,
  schema: S,
): Promise<ApiResult<z.output<S>>> => requestJson(http, { method: "POST", path, body }, schema);

/** A request that has not answered by then counts as a lost connection. */
export const HTTP_TIMEOUT_MS = 10_000;

const readJsonBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/**
 * The browser's HttpPort: `fetch` with a timeout. Rejects when no response arrived, so that
 * `requestJson` reports it as a network error; every status resolves.
 */
export const createFetchHttpPort = (timeoutMs: number = HTTP_TIMEOUT_MS): HttpPort => ({
  async send(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(request.path, {
        method: request.method,
        signal: controller.signal,
        ...(request.body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request.body),
            }),
      });
      return {
        status: response.status,
        body: await readJsonBody(response),
        retryAfter: response.headers.get("Retry-After"),
      };
    } finally {
      clearTimeout(timer);
    }
  },
});
