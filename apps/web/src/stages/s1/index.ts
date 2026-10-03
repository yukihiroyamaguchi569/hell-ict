import { computed, defineAsyncComponent, defineComponent, h } from "vue";

import { createFetchHttpPort } from "../../api/http.js";
import { browserClipboard, browserClock } from "../../browser-ports.js";
import type { ClipboardPort, Clock, HttpPort } from "../../ports.js";
import type { StageContext, StageInstance, StageModule } from "../stage-module.js";
import { stage1InboxRows, stage1MissionDeadline } from "./s1-screen.js";
import { useStage1 } from "./use-stage1.js";
import { useStage1Draft } from "./use-stage1-draft.js";
import { useStage1Screen } from "./use-stage1-screen.js";
import type { Stage1Screen } from "./use-stage1-screen.js";

/*
 * Loaded when first drawn: the registry is imported by Vitest (node, no .vue plugin), which
 * cannot parse a single-file component.
 */
const Stage1Center = defineAsyncComponent(() => import("./Stage1Center.vue"));
const Stage1Windows = defineAsyncComponent(() => import("./Stage1Windows.vue"));

/**
 * What Stage 1 needs beyond `StageContext`: the draft button calls the AI route itself, and the
 * memo's 「本文をコピー」 writes to the clipboard. `StageContext` has neither.
 */
export interface Stage1Ports {
  readonly http: HttpPort;
  readonly clock: Clock;
  readonly clipboard: ClipboardPort;
}

/**
 * Builds Stage 1 on screen. The screen is returned beside the instance for the tests that press
 * its windows' buttons through the frame (the instance only carries bound components).
 */
export const setupStage1 = (
  context: StageContext,
  ports: Stage1Ports,
): { readonly instance: StageInstance; readonly screen: Stage1Screen } => {
  const stage = useStage1(context);
  const draft = useStage1Draft({
    session: context.session,
    stage,
    sessionStorage: context.sessionStorage,
    scheduler: context.scheduler,
    http: ports.http,
    clock: ports.clock,
  });
  const screen = useStage1Screen({ context, stage, draft, clipboard: ports.clipboard });
  const props = { stage, draft, screen };
  // The clear's window comes before the frame's clear effect, which waits for it to close.
  const clearHeld = computed(() => screen.clearWindow.value !== null);
  const instance: StageInstance = {
    center: defineComponent(() => () => h(Stage1Center, props)),
    overlay: defineComponent(() => () => h(Stage1Windows, props)),
    overlayWanted: computed(
      () => screen.mode.value === "waiting" || screen.roundEnd.value !== null || clearHeld.value,
    ),
    holdClear: clearHeld,
    focus: context.mail.openId,
    inbox: { rows: computed(() => stage1InboxRows(stage.rows.value, context.serverNow.value)) },
    karube: stage.karubeCalls,
  };
  return { instance, screen };
};

/**
 * Stage 1（平常運転）: the director's briefing, then rounds of five mails a minute each until a
 * round is clean. The clear shows its window, then goes on to the frame's clear effect.
 */
export const createStage1Module = (ports: Stage1Ports): StageModule => ({
  setup: (context) => setupStage1(context, ports).instance,
  missionDeadline: stage1MissionDeadline,
});

/** The browser's Stage 1 (the same fetch port as the app's other game requests). */
export const stage1: StageModule | null = createStage1Module({
  http: createFetchHttpPort(),
  clock: browserClock,
  clipboard: browserClipboard,
});
