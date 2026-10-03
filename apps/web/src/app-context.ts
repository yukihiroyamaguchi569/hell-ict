import { inject } from "vue";
import type { InjectionKey } from "vue";

import type { StageChat } from "./chat/use-stage-chat.js";
import type { GameSession } from "./composables/use-game-session.js";
import type {
  AudioPort,
  ClipboardPort,
  Clock,
  HttpPort,
  ImagePreloader,
  KeyValueStorage,
  ResumeSignal,
  Scheduler,
} from "./ports.js";

/**
 * What the app is built from. `main.ts` assembles the browser's implementations and provides
 * them; App.vue takes them from here instead of reaching for fetch or localStorage itself.
 */
export interface AppContext {
  readonly session: GameSession;
  /** The AI pane of the current stage (built on `session`). */
  readonly stageChat: StageChat;
  readonly http: HttpPort;
  /** For `GET /api/health` only: the start-up check waits less than a game request. */
  readonly probeHttp: HttpPort;
  readonly clock: Clock;
  readonly storage: KeyValueStorage;
  /**
   * What may go when the tab closes: the stages' drafts and what has been read
   * (`session-record.ts`). localStorage (`storage`) keeps the team and the preferences.
   */
  readonly sessionStorage: KeyValueStorage;
  readonly scheduler: Scheduler;
  readonly resume: ResumeSignal;
  readonly audio: AudioPort;
  readonly clipboard: ClipboardPort;
  /** Fetches images ahead of their use: the opening (Issue #379) and the clear effect (#378). */
  readonly images: ImagePreloader;
  /** Where the first click unlocks sound (browsers block audio until a user gesture). */
  readonly gestureTarget: EventTarget;
}

export const APP_CONTEXT_KEY: InjectionKey<AppContext> = Symbol("app-context");

export const useAppContext = (): AppContext => {
  const context = inject(APP_CONTEXT_KEY, null);
  if (context === null) throw new Error("APP_CONTEXT_KEY has not been provided.");
  return context;
};
