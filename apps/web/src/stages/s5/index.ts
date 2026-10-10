import { computed, defineAsyncComponent, defineComponent, h, markRaw } from "vue";

import type { StageModule } from "../stage-module.js";
import { STAGE5_ROWS, stage5MissionDeadline } from "./s5-view.js";
import { useRedactPenalty } from "./use-redact-penalty.js";
import { useStage5 } from "./use-stage5.js";

/*
 * The components are imported lazily: the registry is imported by tests that run without the
 * Vue SFC compiler, and a static .vue import here would break them (the frame's convention).
 */
const Stage5Center = defineAsyncComponent(() => import("./Stage5Center.vue"));
const Stage5Overlay = defineAsyncComponent(() => import("./Stage5Overlay.vue"));

/**
 * Stage 5「報告」: the head of administration's request, the list for the health centre and its
 * submission, the deadline's call, and the trap's alarm, scold and blacked-out report. The trap
 * is the Worker's gate in front of the AI chat (personal data never reaches OpenAI): the screen
 * sends no command for it and only sees the penalty the server started.
 */
export const stage5: StageModule | null = {
  setup(context) {
    const { session } = context;
    const state = () => session.view.value?.state ?? null;
    const newCommandId = () => session.newCommandId();
    const penalty = useRedactPenalty({
      active: () => state()?.game.penalties.s5 === "in-progress",
      send: (command, commandId) => session.send(command, commandId),
      newCommandId,
      serverNow: context.serverNow,
      scheduler: context.scheduler,
      sfx: context.sfx,
    });
    const stage = useStage5({
      state,
      teamCode: () => session.teamCode.value,
      send: (command, commandId) => session.send(command, commandId),
      newCommandId,
      serverNow: context.serverNow,
      storage: context.sessionStorage,
      scheduler: context.scheduler,
      sfx: context.sfx,
      // Held from the send on: the answer's state (penalty done) is shown before the answer is
      // read, and the window must not close and open again in between.
      penaltyHeld: () => penalty.sending.value || penalty.holding.value,
      piiBlocks: context.chatPiiBlocks,
    });
    return {
      center: markRaw(defineComponent(() => () => h(Stage5Center, { stage }))),
      overlay: markRaw(defineComponent(() => () => h(Stage5Overlay, { stage, penalty }))),
      overlayWanted: computed(() => stage.overlay.value !== null),
      inbox: { rows: computed(() => STAGE5_ROWS) },
    };
  },
  missionDeadline: stage5MissionDeadline,
};
