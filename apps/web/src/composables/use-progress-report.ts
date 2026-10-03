import type { TeamGameViewState, ViewId } from "@hell-ict/domain";
import { onScopeDispose, watch } from "vue";
import type { Ref } from "vue";

import type { Clock, HttpPort, ResumeSignal, Scheduler } from "../ports.js";
import type { GameSession } from "./use-game-session.js";

/*
 * Brings the team's name to the facilitator's dashboard (mock `reportProgress`): one
 * `POST /api/progress` per join. The Worker already records every clear and every stage entered
 * as the game applies them (`recordGameProgress`, with an empty name: the dashboard takes the
 * latest name that is not empty), so the mock's `clear` reports are not sent from here: they
 * would land twice. What only this screen knows is the name.
 *
 * A report counts as sent only on a 2xx. Otherwise it is resent after each of
 * PROGRESS_RETRY_DELAYS_MS, and after that tried once each time the screen comes back (tab
 * visible again, network back) until it lands. The server does not dedupe: a name that lands twice only adds a
 * row, and the dashboard takes the latest name anyway. A report never stops the game.
 */

/** Waits before each resend of a report that got no 2xx. */
export const PROGRESS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

/** entry: joined in the Prologue. resume: came back to a team further on. */
export type ProgressKind = "entry" | "resume";

/** The server keeps this much of the name (the dashboard's column). */
const REPORTED_NAME_MAX = 24;

/** The screen the team is on, in the mock's view ids (the dashboard shows them). */
export const progressViewId = (state: TeamGameViewState): ViewId => {
  const { stage } = state.game;
  if (stage !== "prologue") return stage;
  return state.inbox === null ? "welcome" : "inbox";
};

/** The kind of the report of a join, by where the team is (mock runEnter / resumeFromCheckpoint). */
export const joinReportKind = (view: ViewId): ProgressKind =>
  view === "welcome" || view === "inbox" ? "entry" : "resume";

export interface ProgressReportDeps {
  readonly http: HttpPort;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly resume: ResumeSignal;
  readonly session: GameSession;
  readonly teamName: Readonly<Ref<string>>;
}

const isDelivered = async (http: HttpPort, body: unknown): Promise<boolean> => {
  try {
    const response = await http.send({ method: "POST", path: "/api/progress", body });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
};

export const useProgressReport = (deps: ProgressReportDeps): void => {
  const { session } = deps;
  /** The join already reported (team code and reset generation). */
  let reportedJoin: string | null = null;
  /** A report of the current join that has not landed yet. */
  let unsent: unknown = null;
  /** The resends are used up: the next resume tries once more. */
  let awaitingResume = false;
  let cancelResend: (() => void) | null = null;
  let disposed = false;

  const stopResend = (): void => {
    cancelResend?.();
    cancelResend = null;
  };

  /** Sends `body`; on failure resends after PROGRESS_RETRY_DELAYS_MS[attempt]. */
  const deliver = async (body: unknown, attempt: number): Promise<void> => {
    const delivered = await isDelivered(deps.http, body);
    if (disposed || unsent !== body) return;
    if (delivered) {
      unsent = null;
      return;
    }
    const delayMs = PROGRESS_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      // The timed resends ran out (or a try on resume failed): try again on the next resume.
      awaitingResume = true;
      return;
    }
    cancelResend = deps.scheduler.schedule(() => {
      cancelResend = null;
      void deliver(body, attempt + 1);
    }, delayMs);
  };

  const report = (): void => {
    const view = session.view.value;
    const teamCode = session.teamCode.value;
    const generation = session.generation.value;
    if (session.status.value !== "ready" || view === null) return;
    if (teamCode === null || generation === null) return;
    const join = `${teamCode}:${String(generation)}`;
    if (join === reportedJoin) return;
    reportedJoin = join;
    const viewId = progressViewId(view.state);
    const body = {
      teamCode,
      teamName: deps.teamName.value.slice(0, REPORTED_NAME_MAX),
      pos: view.pos,
      view: viewId,
      kind: joinReportKind(viewId),
      generation,
      clientAt: deps.clock.now().toISOString(),
    };
    stopResend();
    awaitingResume = false;
    unsent = body;
    void deliver(body, 0);
  };

  /** After the timed resends ran out: one try per resume, no new timers, until a 2xx. */
  const retryOnResume = (): void => {
    if (!awaitingResume || unsent === null) return;
    awaitingResume = false;
    void deliver(unsent, PROGRESS_RETRY_DELAYS_MS.length + 1);
  };

  const stopListening = deps.resume.subscribe(retryOnResume);
  onScopeDispose(() => {
    disposed = true;
    stopResend();
    stopListening();
  });

  watch([session.status, session.view], report, { immediate: true });
};
