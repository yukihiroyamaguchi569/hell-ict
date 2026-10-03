/**
 * The screen's boundaries with the outside world. Composables take these as arguments, so tests
 * hand in fakes (`apps/web/test/fakes.ts`) and never touch the network, the real clock,
 * localStorage or audio. The browser's implementations live in `browser-ports.ts`.
 */

export type { Clock, IdGenerator } from "@hell-ict/domain/ports";

export interface HttpRequest {
  readonly method: "GET" | "POST";
  /** Same-origin path, e.g. `/api/teams/123456/game`. */
  readonly path: string;
  /** Sent as JSON. Absent for GET. */
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  /** The parsed JSON body, or `null` when the body is not JSON. Not yet validated. */
  readonly body: unknown;
  /** The raw `Retry-After` header (a 429 carries it), or `null`/absent when there is none. */
  readonly retryAfter?: string | null;
}

/**
 * One HTTP round trip. Resolves with any status (4xx and 5xx included); rejects only when no
 * response arrived (network down, timeout).
 */
export interface HttpPort {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/** localStorage-like. Any call may throw (private mode, blocked site data, quota). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The address bar. `current` is the path, query and hash (`/?reset#x`); `replace` swaps them
 * without a reload or a new history entry.
 */
export interface AddressBar {
  current(): string;
  replace(url: string): void;
}

/**
 * Puts text on the clipboard. When the Clipboard API is missing or refuses, the browser's
 * version falls back to the older copy command; it rejects only when that fails too, so the
 * screen never says "copied" for a copy that did not happen.
 */
export interface ClipboardPort {
  writeText(text: string): Promise<void>;
}

/**
 * Plays named sound effects (`/sounds/<name>.mp3`). Must never throw: a sound must never stop
 * the game.
 */
export interface AudioPort {
  /** `volume` is 0〜1. */
  play(name: string, volume: number): void;
  /** Stops whatever is playing (muting silences the sound that is already on). */
  stopAll(): void;
  /**
   * Loads a sound ahead of its first play (the opening, Issue #379). Never rejects: a sound that
   * fails is fetched again when it is played.
   */
  preload(name: string): Promise<PreloadResult>;
}

/** How a preload ended. A failure is only noted: the asset is fetched again where it is used. */
export type PreloadResult = "loaded" | "failed";

/** Runs a task later. Returns a function that cancels it (a no-op once it has run). */
export interface Scheduler {
  schedule(task: () => void, delayMs: number): () => void;
}

/**
 * Tells when the screen may have missed changes: the tab became visible again or the network
 * came back. Returns a function that stops listening.
 */
export interface ResumeSignal {
  subscribe(listener: () => void): () => void;
}

/**
 * Starts fetching an image into the browser's cache, so an `<img>` with the same src shows it
 * without waiting. Must never throw or reject: a preload is only a head start. An image already
 * loaded or on its way is not asked for again (the opening and the stage's own preload ask for
 * the same pictures); one that failed is asked for again on the next call.
 */
export interface ImagePreloader {
  preload(src: string): Promise<PreloadResult>;
}
