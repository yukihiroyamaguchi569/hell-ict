import { teamCodeSchema } from "@hell-ict/domain";
import type {
  GameCommandResponse,
  GameEvent,
  GameViewResponse,
  TeamCode,
  TeamGameCommand,
} from "@hell-ict/domain";
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from "vue";
import type { ComputedRef } from "vue";

import type { GameApi } from "../api/game-api.js";
import type { ApiResult } from "../api/http.js";
import type { Clock, IdGenerator, KeyValueStorage, ResumeSignal, Scheduler } from "../ports.js";
import { useServerClock } from "./use-server-clock.js";
import type { ServerClock } from "./use-server-clock.js";

/**
 * - idle: no team (first visit, or the saved code was refused).
 * - joining: `POST /api/session` and the first `GET /game` are under way.
 * - ready: the team's game is on screen and commands can be sent.
 * - restore-failed: the saved team code could not be restored (API down). `retry()` again.
 * - stale: the game master reset the team after this tab joined. Nothing is written any more;
 *   the screen asks for a reload.
 */
export type GameSessionStatus = "idle" | "joining" | "ready" | "restore-failed" | "stale";

/** `not-found`: the Worker does not know the code (outside this event's team codes). */
export type JoinOutcome = "ok" | "failed" | "not-found" | "superseded";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command as a button sends it. The session adds the commandId and the reset generation. */
export type GameCommandInput = DistributiveOmit<TeamGameCommand, "commandId" | "generation">;

/**
 * - done: the server answered (applied, rejected or duplicate — the state it sent is on screen).
 * - stale: the tab is older than the game master's reset; nothing was written.
 * - not-ready: no game on screen yet (or the tab is stale): nothing was sent.
 * - unavailable: no answer after every resend. It may or may not have been applied: the next
 *   `GET /game` tells.
 * - failed: refused as malformed, or answered with a body the screen cannot read.
 * - superseded: another team was joined while this was in flight; its answer is dropped.
 */
export type SendOutcome =
  | { readonly kind: "done"; readonly response: GameCommandResponse }
  | { readonly kind: "stale" | "not-ready" | "unavailable" | "failed" | "superseded" };

/**
 * What asking the server again to prepare the stage's conversation came to.
 * - done: the server answered; its view (with the stage AI, `ready` or still `failed`) is on
 *   screen.
 * - stale / not-ready / superseded: as for `SendOutcome`.
 * - failed: no answer, a 503, or anything else: the view on screen is kept. Pressing again is
 *   safe (the server prepares the thread once).
 */
export type PrepareThreadOutcome = "done" | "stale" | "not-ready" | "failed" | "superseded";

/** The screen's view of the game: the state, the band stop, the server clock and the stage AI. */
export type GameView = Pick<GameViewResponse, "state" | "pos" | "serverNow" | "ai">;

export interface GameSessionDeps {
  readonly api: GameApi;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly storage: KeyValueStorage;
  readonly scheduler: Scheduler;
  readonly resume: ResumeSignal;
}

export interface GameSession {
  readonly status: ComputedRef<GameSessionStatus>;
  readonly teamCode: ComputedRef<TeamCode | null>;
  /** The reset generation from `POST /api/session`. Every write carries it. */
  readonly generation: ComputedRef<number | null>;
  readonly view: ComputedRef<GameView | null>;
  readonly serverClock: ServerClock;
  /**
   * Whether this PC has a team saved for `start` to restore (read from storage each time). The
   * opening (Issue #379) is skipped then: the team goes straight back to its game.
   */
  hasSavedTeam(): boolean;
  /** Restores the saved team code, and refetches whenever the tab comes back. */
  start(): Promise<JoinOutcome | "none">;
  join(teamCode: TeamCode): Promise<JoinOutcome>;
  /** After `restore-failed`: tries the saved team code again. */
  retry(): Promise<JoinOutcome | "none">;
  /**
   * `commandId` resends a command the screen already sent once (the same id: an applied one
   * comes back `duplicate` with what it did). Without it the command gets a fresh id.
   */
  send(command: GameCommandInput, commandId?: string): Promise<SendOutcome>;
  /** A fresh commandId, for a command that may have to be pressed again (see `send`). */
  newCommandId(): string;
  /**
   * After the stage AI came back `failed`: asks the server to prepare the stage's conversation
   * again, in the same queue as the other requests that bring a state. Sent once, not resent.
   */
  prepareStageThread(): Promise<PrepareThreadOutcome>;
  /**
   * Another route met the game master's reset (409 stale-generation, e.g. a chat message): the
   * tab turns stale as when a command meets it. Only a game on screen can turn stale.
   */
  markStale(): void;
  /**
   * Which join the game on screen came from: a new number for every join, even of the same team
   * with the same generation (0 while none is on screen). An answer to a request started under
   * another join belongs to a session that is no longer on screen.
   */
  currentJoin(): number;
  /**
   * Hears what each answered command did (a clear, a stage entered …): the one-shot effects
   * that the state alone cannot replay. Returns a function that stops listening.
   */
  onEvents(listener: (events: readonly GameEvent[]) => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
}

/** localStorage key of the joined team (decision B of #238: restored on reload). */
export const TEAM_CODE_STORAGE_KEY = "hellTeamCode";

/** Waits before each resend of a command that got no answer or a 503. */
export const COMMAND_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

const toView = ({ state, pos, serverNow, ai }: GameViewResponse): GameView => ({
  state,
  pos,
  serverNow,
  ai,
});

/**
 * What a command did. A duplicate is a resend whose first answer never reached this tab, so its
 * events are news here too; a rejected command did nothing.
 */
export const commandEvents = (response: GameCommandResponse): readonly GameEvent[] => {
  if (response.status === "applied") return response.events;
  if (response.status === "duplicate") return response.original.events;
  return [];
};

/** No answer, or the Worker said to try again later: the same commandId may be resent. */
const isRetryable = (result: ApiResult<unknown>): boolean =>
  result.kind === "network-error" || (result.kind === "http-error" && result.status === 503);

const isStaleGeneration = (result: ApiResult<unknown>): boolean =>
  result.kind === "http-error" &&
  result.status === 409 &&
  result.error?.code === "stale-generation";

/** localStorage may throw (private mode, blocked site data): the game goes on without it. */
const savedTeamCodeStore = (storage: KeyValueStorage) => ({
  read(): TeamCode | null {
    try {
      return teamCodeSchema.safeParse(storage.getItem(TEAM_CODE_STORAGE_KEY)).data ?? null;
    } catch {
      return null;
    }
  },
  write(teamCode: TeamCode): void {
    try {
      storage.setItem(TEAM_CODE_STORAGE_KEY, teamCode);
    } catch {
      // Not saved: a reload asks for the code again. Nothing else depends on it.
    }
  },
  remove(): void {
    try {
      storage.removeItem(TEAM_CODE_STORAGE_KEY);
    } catch {
      // Left behind: the next restore meets the same refusal and removes it then.
    }
  },
});

/**
 * The team's game as the server has it. The screen never keeps its own copy of the truth: it
 * shows the last state an answer brought, and every command's answer (applied, rejected or
 * duplicate) replaces it.
 *
 * Ordering: the API has no revision, and the Worker may apply a command that left first after
 * a later refetch. So the requests that bring a state (`GET /game` and commands, resends and
 * their waits included) go through one queue: only one is in flight at a time, and each answer
 * is newer than the one on screen. Joins have their own number: only the last join started
 * counts. A join waits for the request in flight; whatever else was queued before it is
 * dropped without being sent.
 */
export const createGameSession = (deps: GameSessionDeps): GameSession => {
  const status = ref<GameSessionStatus>("idle");
  const teamCode = ref<TeamCode | null>(null);
  const generation = ref<number | null>(null);
  const view = shallowRef<GameView | null>(null);
  const serverClock = useServerClock(deps.clock);
  const saved = savedTeamCodeStore(deps.storage);

  let joinSeq = 0;
  /** The join whose game is on screen (0: none). Answers of any other join are dropped. */
  let activeJoin = 0;
  /** The end of the queue of state requests. A new join starts a new one. */
  let queueTail: Promise<unknown> = Promise.resolve();
  let stopResume: (() => void) | null = null;
  const pendingWaits = new Set<() => void>();
  const eventListeners = new Set<(events: readonly GameEvent[]) => void>();

  const nowMs = (): number => deps.clock.now().getTime();

  /** Runs `task` after every state request queued before it has finished. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queueTail.then(task);
    queueTail = run.catch(() => undefined);
    return run;
  };

  const show = (next: GameViewResponse, sentAt: number): void => {
    view.value = toView(next);
    serverClock.record(sentAt, next.serverNow);
  };

  const announce = (events: readonly GameEvent[]): void => {
    if (events.length === 0) return;
    for (const listener of [...eventListeners]) listener(events);
  };

  /** Shows an answer unless the team changed while it was in flight. */
  const showIfCurrent = (join: number, next: GameViewResponse, sentAt: number): void => {
    if (join === activeJoin) show(next, sentAt);
  };

  const wait = (delayMs: number): Promise<void> =>
    new Promise((resolve) => {
      let cancel = (): void => undefined;
      const settle = (): void => {
        pendingWaits.delete(abort);
        resolve();
      };
      const abort = (): void => {
        cancel();
        settle();
      };
      pendingWaits.add(abort);
      cancel = deps.scheduler.schedule(settle, delayMs);
    });

  const failJoin = (result: ApiResult<unknown>, restoring: boolean): JoinOutcome => {
    const notFound = result.kind === "http-error" && result.status === 404;
    if (notFound && restoring) saved.remove();
    if (restoring && !notFound) {
      status.value = "restore-failed";
      return "failed";
    }
    status.value = "idle";
    teamCode.value = null;
    return notFound ? "not-found" : "failed";
  };

  /**
   * Joining is `POST /api/session` (the generation comes only with it) and then `GET /game`.
   * The same path serves a join from the entry form and a restore after a reload.
   */
  const openSession = async (code: TeamCode, restoring: boolean): Promise<JoinOutcome> => {
    const seq = ++joinSeq;
    activeJoin = 0;
    // The old queue's unsent requests and resend waits end without sending (they see
    // `activeJoin` change). The one already in flight is waited for before the first GET below:
    // the server may apply it after that GET, and its answer is dropped, so the screen would keep
    // the state from before it. The queue is kept, not replaced, so that a second join started
    // meanwhile waits for the same request too.
    const previousQueue = queueTail;
    for (const abort of [...pendingWaits]) abort();
    status.value = "joining";
    teamCode.value = code;
    generation.value = null;
    view.value = null;
    const session = await deps.api.openSession(code);
    if (seq !== joinSeq) return "superseded";
    if (session.kind !== "ok") return failJoin(session, restoring);
    await previousQueue;
    if (seq !== joinSeq) return "superseded";
    const sentAt = nowMs();
    const game = await deps.api.fetchGame(code);
    if (seq !== joinSeq) return "superseded";
    if (game.kind !== "ok") return failJoin(game, restoring);
    activeJoin = seq;
    generation.value = session.value.generation;
    show(game.value, sentAt);
    status.value = "ready";
    saved.write(code);
    return "ok";
  };

  const restore = (): Promise<JoinOutcome | "none"> => {
    const code = saved.read();
    return code === null ? Promise.resolve("none") : openSession(code, true);
  };

  const interrupted = (join: number): { readonly kind: "superseded" | "stale" } | null => {
    if (join !== activeJoin) return { kind: "superseded" };
    return status.value === "stale" ? { kind: "stale" } : null;
  };

  const refetch = async (code: TeamCode, join: number): Promise<void> => {
    if (interrupted(join) !== null) return;
    const sentAt = nowMs();
    const result = await deps.api.fetchGame(code);
    // A failed refetch keeps the last state on screen: the next one will catch up.
    if (result.kind === "ok") showIfCurrent(join, result.value, sentAt);
  };

  const refresh = (): Promise<void> => {
    const code = teamCode.value;
    if (status.value !== "ready" || code === null) return Promise.resolve();
    const join = activeJoin;
    return enqueue(() => refetch(code, join));
  };

  /** One answer to a command: what to report, or `null` to resend the same command. */
  const settle = (
    result: ApiResult<GameCommandResponse>,
    context: { join: number; sentAt: number },
  ): SendOutcome | null => {
    if (result.kind === "ok") {
      if (context.join === activeJoin) {
        show(result.value, context.sentAt);
        announce(commandEvents(result.value));
      }
      return { kind: "done", response: result.value };
    }
    if (isStaleGeneration(result)) {
      status.value = "stale";
      return { kind: "stale" };
    }
    return isRetryable(result) ? null : { kind: "failed" };
  };

  /**
   * Sends a command, resending it with the same commandId while there is no answer or a 503
   * (the server applies a commandId once: a resend of an applied command comes back
   * `duplicate`). Gives up after COMMAND_RETRY_DELAYS_MS.
   */
  const deliver = async (
    code: TeamCode,
    command: TeamGameCommand,
    join: number,
  ): Promise<SendOutcome> => {
    for (const delayMs of [0, ...COMMAND_RETRY_DELAYS_MS]) {
      if (delayMs > 0) await wait(delayMs);
      const stop = interrupted(join);
      if (stop !== null) return stop;
      const sentAt = nowMs();
      const result = await deps.api.sendCommand(code, command);
      const outcome = interrupted(join) ?? settle(result, { join, sentAt });
      if (outcome !== null) return outcome;
    }
    return { kind: "unavailable" };
  };

  const send = (input: GameCommandInput, commandId?: string): Promise<SendOutcome> => {
    const code = teamCode.value;
    const currentGeneration = generation.value;
    if (status.value !== "ready" || code === null || currentGeneration === null) {
      return Promise.resolve({ kind: status.value === "stale" ? "stale" : "not-ready" });
    }
    const command: TeamGameCommand = {
      ...input,
      commandId: commandId ?? deps.ids.next(),
      generation: currentGeneration,
    };
    const join = activeJoin;
    return enqueue(() => deliver(code, command, join));
  };

  const requestStageThread = async (
    code: TeamCode,
    currentGeneration: number,
    join: number,
  ): Promise<PrepareThreadOutcome> => {
    const before = interrupted(join);
    if (before !== null) return before.kind;
    const sentAt = nowMs();
    const result = await deps.api.prepareStageThread(code, currentGeneration);
    const after = interrupted(join);
    if (after !== null) return after.kind;
    if (result.kind === "ok") {
      show(result.value, sentAt);
      return "done";
    }
    if (isStaleGeneration(result)) {
      status.value = "stale";
      return "stale";
    }
    return "failed";
  };

  const prepareStageThread = (): Promise<PrepareThreadOutcome> => {
    const code = teamCode.value;
    const currentGeneration = generation.value;
    if (status.value !== "ready" || code === null || currentGeneration === null) {
      return Promise.resolve(status.value === "stale" ? "stale" : "not-ready");
    }
    const join = activeJoin;
    return enqueue(() => requestStageThread(code, currentGeneration, join));
  };

  const dispose = (): void => {
    stopResume?.();
    stopResume = null;
    // A join under way is dropped when its answer comes (it is no longer the last one), and
    // queued requests and pending resends see a join that is no longer on screen.
    joinSeq += 1;
    activeJoin = 0;
    queueTail = Promise.resolve();
    for (const abort of [...pendingWaits]) abort();
  };

  if (getCurrentScope() !== undefined) onScopeDispose(dispose);

  return {
    status: computed(() => status.value),
    teamCode: computed(() => teamCode.value),
    generation: computed(() => generation.value),
    view: computed(() => view.value),
    serverClock,
    hasSavedTeam: () => saved.read() !== null,
    start() {
      stopResume ??= deps.resume.subscribe(() => {
        void refresh();
      });
      return restore();
    },
    join: (code) => openSession(code, false),
    retry: () => {
      const code = teamCode.value;
      return status.value === "restore-failed" && code !== null
        ? openSession(code, true)
        : Promise.resolve("none");
    },
    send,
    newCommandId: () => deps.ids.next(),
    prepareStageThread,
    markStale() {
      if (status.value === "ready") status.value = "stale";
    },
    currentJoin: () => activeJoin,
    onEvents(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    refresh,
    dispose,
  };
};
