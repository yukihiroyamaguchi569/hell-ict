import { computed, readonly, ref } from "vue";
import type { ComputedRef, Ref } from "vue";

import {
  checkEntry,
  entryNotice,
  isHealthy,
  joinErrorMessage,
  type EntryNotice,
  type ProbeState,
} from "../entry/entry-view.js";
import type { HttpPort } from "../ports.js";
import type { GameSession } from "./use-game-session.js";
import type { TeamName } from "./use-team-name.js";

export interface EntryDeps {
  readonly session: GameSession;
  /** For `GET /api/health` only: a shorter timeout than the game's requests. */
  readonly probeHttp: HttpPort;
  readonly teamName: TeamName;
}

export interface Entry {
  readonly notice: ComputedRef<EntryNotice>;
  /** Why the last try from the form did not go through ("" for none). */
  readonly error: Readonly<Ref<string>>;
  /** Checks the API, and once it answers, restores the team saved on this PC. */
  start(): Promise<void>;
  enter(teamCode: string, teamName: string): Promise<void>;
  /** What [再試行] does in the notice's state. */
  retry(): Promise<void>;
}

/** Asks the Worker whether it is up. Never throws: no answer is a failure. */
const probeHealth = async (http: HttpPort): Promise<boolean> => {
  try {
    const response = await http.send({ method: "GET", path: "/api/health" });
    return response.status === 200 && isHealthy(response.body);
  } catch {
    return false;
  }
};

/**
 * The entry form (mock attemptEnter / probeLive). Nothing is entered until the API is known to
 * answer; the restore of the saved team waits for that too, so that an API that is down shows
 * one error and one [再試行] instead of two.
 */
export const useEntry = (deps: EntryDeps): Entry => {
  const probe = ref<ProbeState>("pending");
  const entering = ref(false);
  const error = ref("");
  let restoreStarted = false;

  const notice = computed(() =>
    entryNotice({
      probe: probe.value,
      status: deps.session.status.value,
      entering: entering.value,
    }),
  );

  const start = async (): Promise<void> => {
    probe.value = "pending";
    probe.value = (await probeHealth(deps.probeHttp)) ? "ok" : "failed";
    if (probe.value !== "ok" || restoreStarted) return;
    restoreStarted = true;
    await deps.session.start();
  };

  const enter = async (teamCode: string, teamName: string): Promise<void> => {
    if (!notice.value.canEnter) return;
    const checked = checkEntry(teamCode, teamName);
    if (!checked.ok) {
      error.value = checked.message;
      return;
    }
    error.value = "";
    entering.value = true;
    // Kept before joining, so that the name is there when the team first shows (the chip and
    // the first progress report). A join that fails leaves it under a code nobody plays.
    deps.teamName.remember(checked.teamCode, checked.teamName);
    try {
      error.value = joinErrorMessage(await deps.session.join(checked.teamCode));
    } finally {
      entering.value = false;
    }
  };

  const retry = async (): Promise<void> => {
    const target = notice.value.retry;
    if (target === "probe") await start();
    if (target === "restore") await deps.session.retry();
  };

  return { notice, error: readonly(error), start, enter, retry };
};
