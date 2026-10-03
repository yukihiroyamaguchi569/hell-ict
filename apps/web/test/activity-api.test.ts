import { describe, expect, it } from "vitest";

import {
  ACTIVITY_RETRY_AFTER_CAP_MS,
  ACTIVITY_RETRY_DELAYS_MS,
  activityNext,
} from "../src/api/activity-api.js";
import type { ApiResult } from "../src/api/http.js";

// The request itself (path and body) is checked where it is sent: test/stages/final/use-final.
const http = (
  status: number,
  code?: "stale-generation",
  retryAfterSeconds: number | null = null,
): ApiResult<unknown> => ({
  kind: "http-error",
  status,
  error: code === undefined ? null : { message: "x", code },
  retryAfterSeconds,
});
const retry = (delayMs: number) => ({ kind: "retry", delayMs });

describe("activityNext", () => {
  it.each([
    ["成功", { kind: "ok", value: { ok: true } }, 0, { kind: "done" }],
    ["400", http(400), 0, { kind: "done" }],
    ["409（stale-generation 以外）", http(409), 0, { kind: "done" }],
    ["499", http(499), 0, { kind: "done" }],
    ["形の違う応答", { kind: "invalid-response" }, 0, { kind: "done" }],
    ["409 stale-generation", http(409, "stale-generation"), 0, { kind: "stale" }],
    ["切断の1回目", { kind: "network-error" }, 0, retry(ACTIVITY_RETRY_DELAYS_MS[0])],
    ["500 の3回目", http(500), 2, retry(ACTIVITY_RETRY_DELAYS_MS[2])],
    ["Retry-After の無い 429", http(429), 1, retry(ACTIVITY_RETRY_DELAYS_MS[1])],
    ["Retry-After 30秒の 429", http(429, undefined, 30), 0, retry(30_000)],
    [
      "Retry-After が上限超えの 429",
      http(429, undefined, 3_600),
      0,
      retry(ACTIVITY_RETRY_AFTER_CAP_MS),
    ],
    ["送り直しを使い切った切断", { kind: "network-error" }, 3, { kind: "give-up" }],
    ["送り直しを使い切った 429", http(429, undefined, 5), 3, { kind: "give-up" }],
  ] as const)("%s", (_, result, attempt, next) => {
    expect(activityNext(result, attempt)).toEqual(next);
  });
});
