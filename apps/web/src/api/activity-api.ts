import type { TeamCode, ViewId } from "@hell-ict/domain";
import { z } from "zod";

import type { HttpPort } from "../ports.js";
import { postJson } from "./http.js";
import type { ApiResult } from "./http.js";

/**
 * The activity log of the Worker (`apps/worker/src/activity-log.ts`): what a team wrote, kept for
 * the debriefing (its SQL reads `submit.final`). It is a record, not the game: a failure never
 * stops the screen. The Worker drops PII from `text` before it keeps a row.
 */

/** The kinds this screen sends (the Worker accepts more; add them here as they are used). */
export type ActivityKind = "submit.final";

export interface ActivityEntry {
  /** Idempotent: a resend under the same id is kept once. */
  readonly commandId: string;
  readonly kind: ActivityKind;
  readonly view: ViewId;
  readonly text: string;
  /** ISO time when it happened. */
  readonly clientAt: string;
  /** The reset generation from `POST /api/session`. */
  readonly generation: number;
}

const activityResponseSchema = z.object({ ok: z.literal(true) });

export interface ActivityApi {
  /** `POST /api/teams/:code/activity`. */
  record(teamCode: TeamCode, entry: ActivityEntry): Promise<ApiResult<{ ok: true }>>;
}

export const createActivityApi = (http: HttpPort): ActivityApi => ({
  record: (teamCode, entry) =>
    postJson(http, `/api/teams/${teamCode}/activity`, entry, activityResponseSchema),
});

/** The waits before sending the same entry again (a 429's `Retry-After` replaces them). */
export const ACTIVITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/** A `Retry-After` longer than this is waited only this long. */
export const ACTIVITY_RETRY_AFTER_CAP_MS = 60_000;

/**
 * What to do after an answer:
 * - done: kept, or refused for good (400 …): nothing more to send.
 * - stale: the game master reset the team (409 stale-generation): the tab turns stale.
 * - retry: no answer, a busy Worker (5xx) or too many rows (429): send it again after `delayMs`.
 * - give-up: still worth sending, but the resends of this stay are used up (`attempt` counts them).
 */
export type ActivityNext =
  | { readonly kind: "done" | "stale" | "give-up" }
  | { readonly kind: "retry"; readonly delayMs: number };

const retryable = (result: ApiResult<unknown>): boolean =>
  result.kind === "network-error" ||
  (result.kind === "http-error" && (result.status === 429 || result.status >= 500));

const retryAfterMs = (result: ApiResult<unknown>): number | null =>
  result.kind === "http-error" && result.status === 429 && result.retryAfterSeconds !== null
    ? Math.min(result.retryAfterSeconds * 1_000, ACTIVITY_RETRY_AFTER_CAP_MS)
    : null;

export const activityNext = (result: ApiResult<unknown>, attempt: number): ActivityNext => {
  const stale =
    result.kind === "http-error" &&
    result.status === 409 &&
    result.error?.code === "stale-generation";
  if (stale) return { kind: "stale" };
  if (!retryable(result)) return { kind: "done" };
  const backoff = ACTIVITY_RETRY_DELAYS_MS[attempt];
  if (backoff === undefined) return { kind: "give-up" };
  return { kind: "retry", delayMs: retryAfterMs(result) ?? backoff };
};
