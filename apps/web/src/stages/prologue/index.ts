import { defineAsyncComponent, defineComponent, h } from "vue";

import type { StageModule } from "../stage-module.js";
import { usePrologue } from "./use-prologue.js";

/*
 * Loaded when first drawn: the registry is imported by Vitest (node, no .vue plugin), which
 * cannot parse a single-file component.
 */
const PrologueCenter = defineAsyncComponent(() => import("./PrologueCenter.vue"));

/**
 * Prologue（受信トレイ）: three mails to answer within five minutes of opening the inbox. The
 * welcome's 「メールを開く」 (App.vue) sends `inbox.open`; everything after it is here.
 */
export const prologueStage: StageModule = {
  setup(context) {
    const prologue = usePrologue(context);
    return {
      center: defineComponent(() => () => h(PrologueCenter, { prologue })),
      focus: prologue.openMail,
      inbox: { rows: prologue.rows },
    };
  },
};
