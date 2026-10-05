import { computed, defineAsyncComponent, h } from "vue";
import type { Component } from "vue";

import type { StageModule } from "../stage-module.js";
import { stage3InboxRows } from "./s3-view.js";
import { useBottlePenalty } from "./use-bottle-penalty.js";
import { useStage3 } from "./use-stage3.js";

/*
 * The components are loaded on first use, not imported here: the registry (and so this file) is
 * imported by the Vitest tests of the frame, which run without the Vue SFC compiler.
 */
const Stage3Center = defineAsyncComponent<Component>(() => import("./Stage3Center.vue"));
const Stage3Overlay = defineAsyncComponent<Component>(() => import("./Stage3Overlay.vue"));

/**
 * Stage 3（方針）: the director's notice, the three fields and their submission, the trap's first
 * firing and its bottle penalty. The trap is the server's (the contaminated table and the system
 * prompt of the stage AI); the way out is the manual in the shared viewer. The clear effect is
 * the frame's. 苅部さん speaks after a rejection, after the penalty and on repeated traps (#219).
 */
export const stage3: StageModule = {
  setup(context) {
    const { session } = context;
    const state = () => session.view.value?.state ?? null;
    const stage = useStage3({
      state,
      teamCode: () => session.teamCode.value,
      send: (command) => session.send(command),
      serverNow: context.serverNow,
      storage: context.sessionStorage,
      scheduler: context.scheduler,
      sfx: context.sfx,
    });
    const penalty = useBottlePenalty({
      active: () => stage.overlay.value === "penalty",
      send: (command, commandId) => session.send(command, commandId),
      newCommandId: () => session.newCommandId(),
      serverNow: context.serverNow,
      scheduler: context.scheduler,
      sfx: context.sfx,
      onFinishing: () => {
        stage.penaltyFinishing();
      },
      onFinished: (paid) => {
        stage.penaltyFinished(paid);
      },
    });
    return {
      center: { render: () => h(Stage3Center, { stage }) },
      overlay: { render: () => h(Stage3Overlay, { stage, penalty }) },
      overlayWanted: computed(() => stage.overlay.value !== null),
      inbox: { rows: computed(() => stage3InboxRows) },
      karube: stage.karubeCalls,
    };
  },
};
