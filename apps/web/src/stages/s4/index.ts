import { computed, defineAsyncComponent, defineComponent, h, markRaw } from "vue";

import type { StageModule } from "../stage-module.js";
import { STAGE4_ROWS } from "./s4-view.js";
import { useStage4 } from "./use-stage4.js";

/*
 * The components are imported lazily: the registry is imported by tests that run without the
 * Vue SFC compiler, and a static .vue import here would break them (the frame's convention).
 */
const Stage4Center = defineAsyncComponent(() => import("./Stage4Center.vue"));
const DirectorWindow = defineAsyncComponent(() => import("./DirectorWindow.vue"));

/**
 * Stage 4 「新情報の解釈」: the director asks for a summary of the foreign report, then what the
 * team will do about it. No trap and no deadline; the right pane keeps the frame's default (the
 * AI is out).
 */
export const stage4: StageModule | null = {
  setup(context) {
    const s4 = useStage4(context);
    return {
      center: markRaw(defineComponent(() => () => h(Stage4Center, { s4 }))),
      overlay: markRaw(defineComponent(() => () => h(DirectorWindow, { director: s4.director }))),
      overlayWanted: s4.director.visible,
      inbox: { rows: computed(() => STAGE4_ROWS) },
    };
  },
};
