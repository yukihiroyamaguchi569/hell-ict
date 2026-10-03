import { gameInstantSchema, initialTeamGameState, initialTeamSnapshot } from "@hell-ict/domain";
import type { GameInstant } from "@hell-ict/domain";

import type {
  HttpPort,
  HttpRequest,
  HttpResponse,
  KeyValueStorage,
  ResumeSignal,
  Scheduler,
} from "../src/ports.js";

/** Lets every settled promise run its continuations (the fakes answer asynchronously). */
export const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export const START_MS = Date.parse("2026-10-31T01:00:00.000Z");
const START: GameInstant = gameInstantSchema.parse(new Date(START_MS).toISOString());

/** The body of `GET /game` as the Worker sends it (without D1's processed command ids). */
export const viewBody = (pos: number, serverNow: number = START_MS) => {
  const { game, ...rest } = initialTeamGameState(START);
  const { processedCommandIds, ...shownGame } = game;
  void processedCommandIds;
  return { state: { ...rest, game: shownGame }, pos, serverNow, ai: { status: "none" } };
};

/** The body of `POST /api/session`: the team's snapshot and the reset generation. */
export const sessionBody = (teamCode: string, generation: number) => ({
  ...initialTeamSnapshot(teamCode),
  generation,
});

/** A chat message as the Worker stores it (the id is derived from `n` so tests stay readable). */
export const chatMessageBody = (n: number, role: "user" | "assistant", text: string) => ({
  messageId: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
  role,
  text,
  createdAt: new Date(START_MS + n * 1_000).toISOString(),
});

/** The body of `GET /api/teams/:code/chat`: threads keyed by id, in the given order. */
export const chatSnapshotBody = (
  revision: number,
  threads: Readonly<Record<string, readonly ReturnType<typeof chatMessageBody>[]>>,
  commands?: Readonly<Record<string, "pending" | "processed" | "unknown">>,
) => ({
  teamCode: "123456",
  revision,
  threads: Object.entries(threads).map(([threadId, messages], index) => ({
    threadId,
    title: `Stage ${String(index + 1)}`,
    kind: "stage",
    messages,
  })),
  ...(commands === undefined ? {} : { commands }),
});

export const ok = (body: unknown): HttpResponse => ({ status: 200, body });
export const unavailable = (): HttpResponse => ({
  status: 503,
  body: { message: "時間を置いて再試行してください。" },
});
export const staleGeneration = (): HttpResponse => ({
  status: 409,
  body: { message: "古くなっています。", code: "stale-generation" },
});

/** An answer the test releases by hand, to control the order in which answers arrive. */
export interface Deferred {
  readonly promise: Promise<HttpResponse>;
  resolve(response: HttpResponse): void;
  reject(error: Error): void;
}

export const deferred = (): Deferred => {
  let resolve: (response: HttpResponse) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<HttpResponse>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

type Handler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/** Records every request and answers it with `handler`. A throwing handler is a lost connection. */
export class FakeHttp implements HttpPort {
  readonly requests: HttpRequest[] = [];

  constructor(public handler: Handler) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    try {
      return Promise.resolve(this.handler(request));
    } catch (caught) {
      return Promise.reject(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }

  to(pathSuffix: string): HttpRequest[] {
    return this.requests.filter((request) => request.path.endsWith(pathSuffix));
  }
}

/**
 * A server that behaves like the Worker for the session: `POST /api/session` gives the
 * generation, `GET /game` the view, and each new commandId moves the team one stop (a resent
 * one comes back `duplicate`). `applied` counts the commands it really applied.
 */
export class FakeGameServer {
  generation = 3;
  pos = 0;
  readonly applied = new Map<string, number>();

  handle = (request: HttpRequest): HttpResponse => {
    if (request.path === "/api/session") return ok(sessionBody("123456", this.generation));
    if (request.path.endsWith("/game")) return ok(viewBody(this.pos));
    return this.command(request.body);
  };

  private command(body: unknown): HttpResponse {
    const commandId =
      typeof body === "object" && body !== null && "commandId" in body
        ? String(body.commandId)
        : "";
    const count = this.applied.get(commandId) ?? 0;
    this.applied.set(commandId, count + 1);
    if (count > 0) {
      return ok({
        status: "duplicate",
        original: { events: [], judgement: null },
        ...viewBody(this.pos),
      });
    }
    this.pos += 1;
    return ok({ status: "applied", events: [], judgement: null, ...viewBody(this.pos) });
  }
}

/** localStorage stand-in. `failing` makes every call throw, as blocked site data does. */
export class FakeKeyValueStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  failing = false;

  getItem(key: string): string | null {
    this.check();
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.check();
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.check();
    this.values.delete(key);
  }

  private check(): void {
    if (this.failing) throw new Error("SecurityError: storage is blocked");
  }
}

/** Timers that run only when the test advances them. `delays` keeps every requested delay. */
export class FakeScheduler implements Scheduler {
  readonly delays: number[] = [];
  private now = 0;
  private tasks: { dueAt: number; task: () => void }[] = [];

  schedule(task: () => void, delayMs: number): () => void {
    this.delays.push(delayMs);
    const entry = { dueAt: this.now + delayMs, task };
    this.tasks.push(entry);
    return () => {
      this.tasks = this.tasks.filter((other) => other !== entry);
    };
  }

  get pending(): number {
    return this.tasks.length;
  }

  advanceBy(milliseconds: number): void {
    this.now += milliseconds;
    const due = this.tasks.filter((entry) => entry.dueAt <= this.now);
    this.tasks = this.tasks.filter((entry) => entry.dueAt > this.now);
    for (const entry of due) entry.task();
  }
}

export class FakeResumeSignal implements ResumeSignal {
  readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  fire(): void {
    for (const listener of this.listeners) listener();
  }
}
