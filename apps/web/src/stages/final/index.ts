import { finalJimuMail, finalKohoMail } from "@hell-ict/content";
import { computed, defineAsyncComponent, defineComponent, h, markRaw, watch } from "vue";

import { createActivityApi } from "../../api/activity-api.js";
import { createFetchHttpPort } from "../../api/http.js";
import type { InboxRow, StageModule } from "../stage-module.js";
import { overlayScene } from "./final-view.js";
import { useFinal } from "./use-final.js";

/*
 * The components are imported lazily: the registry is imported by tests that run without the
 * Vue SFC compiler, and a static .vue import here would break them (the frame's convention).
 */
const FinalCenter = defineAsyncComponent(() => import("./FinalCenter.vue"));
const FinalOverlay = defineAsyncComponent(() => import("./FinalOverlay.vue"));

/** The two mails of Final (mock renderFinal), both read in the shared viewer. */
const FINAL_ROWS: readonly InboxRow[] = [
  {
    id: "fjimu",
    from: finalJimuMail.from,
    subject: finalJimuMail.subj,
    opens: { kind: "viewer", doc: "fjimu" },
  },
  {
    id: "fpress",
    from: finalKohoMail.from,
    subject: finalKohoMail.subj,
    attach: finalKohoMail.attach,
    opens: { kind: "viewer", doc: "fpress" },
  },
];

const activity = createActivityApi(createFetchHttpPort());

/**
 * Final（振り返り）: the goal and the director's epilogue, the board of six tiles and the line for
 * the next team, the relay of three voices and the certificate. Nothing is judged and no game
 * command is sent; the line goes to the activity log for the debriefing. The right pane keeps
 * the frame's default (hidden: nothing is left to ask the AI).
 */
export const finalStage: StageModule | null = {
  setup(context) {
    const final = useFinal(context, activity);
    // The same applause at the race's end and at the training's end (mock goalSequence,
    // fShowHandover), each time the scene comes up again.
    watch(
      () => final.phase.value.kind,
      (kind) => {
        if (kind === "goal" || kind === "handover") context.sfx.play("hall-clapping-hands1");
      },
      { immediate: true },
    );
    return {
      center: markRaw(defineComponent(() => () => h(FinalCenter, { final }))),
      overlay: markRaw(defineComponent(() => () => h(FinalOverlay, { final }))),
      overlayWanted: computed(() => overlayScene(final.phase.value)),
      inbox: { rows: computed(() => FINAL_ROWS) },
    };
  },
};
