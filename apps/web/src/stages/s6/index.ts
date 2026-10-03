import { computed, defineAsyncComponent, h, shallowRef } from "vue";
import type { Component } from "vue";

import type { ChatReplyImage } from "../../chat/pane-items.js";
import type { StageModule } from "../stage-module.js";
import { STAGE6_ROWS } from "./s6-view.js";
import { useStage6 } from "./use-stage6.js";

/*
 * The components are loaded on first use, not imported here: the registry (and so this file) is
 * imported by the Vitest tests of the frame, which run without the Vue SFC compiler.
 */
const Stage6Center = defineAsyncComponent<Component>(() => import("./Stage6Center.vue"));
const Stage6Overlay = defineAsyncComponent<Component>(() => import("./Stage6Overlay.vue"));

/**
 * Stage 6（掲示）: 事務長's call, the poster generated in the right pane's own conversation
 * (`chat`: drawn from the server's prompt log and candidates, never the server's AI), the
 * candidate picked and its submission. Sent back only: no trap, no penalty, no limit.
 */
export const stage6: StageModule | null = {
  setup(context) {
    const s6 = useStage6(context);
    /** The poster enlarged over the screen (mock #ov-lightbox): memory only. */
    const zoomed = shallowRef<ChatReplyImage | null>(null);
    const zoom = (image: ChatReplyImage): void => {
      zoomed.value = image;
    };
    return {
      center: { render: () => h(Stage6Center, { s6, zoom }) },
      overlay: {
        render: () =>
          h(Stage6Overlay, {
            taskOpen: s6.taskOpen.value,
            zoomed: zoomed.value,
            onCloseTask: s6.closeTask,
            onCloseZoom: () => {
              zoomed.value = null;
            },
          }),
      },
      overlayWanted: computed(() => s6.taskOpen.value || zoomed.value !== null),
      inbox: { rows: computed(() => STAGE6_ROWS) },
      karube: s6.karube,
      chat: s6.chat,
    };
  },
};
