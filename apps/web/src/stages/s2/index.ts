import { stage2SendToGrid, stage2WorkText } from "@hell-ict/content";
import { computed, defineAsyncComponent, h } from "vue";
import type { FunctionalComponent, Ref } from "vue";

import type { ChatSubmit } from "../../chat/use-scripted-chat.js";
import { injectViewer } from "../../viewer/use-viewer.js";
import type { StageModule } from "../stage-module.js";
import { stage2KarubeCalls, stage2RightPane, stage2ScriptedAnswer } from "./s2-ai.js";
import { useStage2, type Stage2 } from "./use-stage2.js";

/*
 * Stage 2（火の手）: the grid, the deadline's addendum and the judge, and the AI — 苅部さん rings
 * 45 s in, opening his call brings in the right pane, whose scripted answer has ［表に送る］.
 * The AI never reaches the server: its conversation is gone on a reload (user decision 9).
 */

// Loaded on demand: the unit tests run without Vue's SFC compiler.
const Stage2Center = defineAsyncComponent(() => import("./Stage2Center.vue"));

/** ［表に追加］ in the addendum's viewer: closes the viewer (mock #btn-take) and takes the rows. */
const takeButton =
  (stage: Stage2): FunctionalComponent =>
  () => {
    const viewer = injectViewer();
    return h(
      "button",
      {
        type: "button",
        "data-testid": "s2-take",
        onClick: () => {
          viewer.close();
          void stage.take();
        },
      },
      stage2WorkText.take,
    );
  };

/** The scripted answer with ［表に送る］, which pours its table into the grid. */
const scriptedAnswer =
  (stage: Stage2, serverNow: Readonly<Ref<number>>): ChatSubmit =>
  () => {
    const answer = stage2ScriptedAnswer(stage.state.value, serverNow.value);
    const run = (): void => {
      stage.sendTable(answer.table);
    };
    return { text: answer.text, action: { label: stage2SendToGrid, run } };
  };

export const stage2: StageModule = {
  setup(context) {
    const stage = useStage2(context);
    const take = takeButton(stage);
    const center: FunctionalComponent = () => h(Stage2Center, { stage });
    const { serverNow, karubeRead } = context;
    return {
      center,
      inbox: { rows: stage.inboxRows },
      viewerToolbar: (doc) => (doc === "add" && stage.canTake.value ? take : null),
      karube: computed(() =>
        stage2KarubeCalls(stage.state.value, serverNow.value, stage.cleared.value),
      ),
      rightPane: computed(() =>
        stage2RightPane(stage.state.value, serverNow.value, karubeRead.value),
      ),
      chatSubmit: scriptedAnswer(stage, serverNow),
    };
  },
};
