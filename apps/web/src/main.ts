import { createApp } from "vue";

import { createChatApi } from "./api/chat-api.js";
import { createGameApi } from "./api/game-api.js";
import { createFetchHttpPort } from "./api/http.js";
import { APP_CONTEXT_KEY } from "./app-context.js";
import App from "./App.vue";
import {
  browserAddressBar,
  browserClipboard,
  browserClock,
  browserIds,
  browserImagePreloader,
  browserResumeSignal,
  browserScheduler,
  browserSessionStorage,
  browserStorage,
} from "./browser-ports.js";
import { createStageChat } from "./chat/use-stage-chat.js";
import { createGameSession } from "./composables/use-game-session.js";
import { createBrowserSfxAudio } from "./composables/use-sfx.js";
import { forgetSavedTeamIfAsked } from "./saved-team-reset.js";
import "./styles.css";

/**
 * The start-up check of the API (mock LIVE_PROBE_TIMEOUT_MS): long enough for a cold start in
 * production, short enough that a venue without the API hears about it quickly.
 */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

const root = document.querySelector("#root");

if (root === null) {
  throw new Error("アプリケーションの表示領域が見つかりません。");
}

forgetSavedTeamIfAsked({ address: browserAddressBar, storage: browserStorage });

const http = createFetchHttpPort();
const session = createGameSession({
  api: createGameApi(http),
  clock: browserClock,
  ids: browserIds,
  storage: browserStorage,
  scheduler: browserScheduler,
  resume: browserResumeSignal,
});
const stageChat = createStageChat({
  api: createChatApi(http, browserClock),
  session,
  ids: browserIds,
  storage: browserSessionStorage,
});

const app = createApp(App);
app.provide(APP_CONTEXT_KEY, {
  session,
  stageChat,
  http,
  probeHttp: createFetchHttpPort(HEALTH_PROBE_TIMEOUT_MS),
  clock: browserClock,
  storage: browserStorage,
  sessionStorage: browserSessionStorage,
  scheduler: browserScheduler,
  resume: browserResumeSignal,
  audio: createBrowserSfxAudio(),
  clipboard: browserClipboard,
  images: browserImagePreloader,
  gestureTarget: document,
});
app.mount(root);
