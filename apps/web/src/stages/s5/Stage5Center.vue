<script setup lang="ts">
import { stage5Brief, stage5Labels } from "@hell-ict/content";

import VerdictBox from "../../verdict/VerdictBox.vue";
import type { Stage5 } from "./use-stage5.js";

/*
 * Stage 5's centre pane (mock renderStage5): the task, the list for the health centre and its
 * submission. The deadline is the mission bar's (user decision 6). While a submission is judged
 * the list is read-only and the button is gone; it stays gone once the stage is cleared. The
 * list is kept in memory only (user decision 4): it may hold patient names.
 */
const props = defineProps<{ stage: Stage5 }>();
const { text, submitting, verdict, warn } = props.stage;
</script>

<template>
  <div class="work" data-testid="s5-center">
    <div class="case">
      <div class="brief">{{ stage5Brief }}</div>
    </div>
    <div class="box" :class="{ warn }" data-testid="s5-box">
      <textarea
        v-model="text"
        class="submit-area"
        :aria-label="stage5Labels.listField"
        :readonly="submitting"
      ></textarea>
    </div>
    <div v-if="!submitting && verdict?.kind !== 'cleared'" class="row-end">
      <button type="button" class="btn" @click="stage.submit">{{ stage5Labels.submit }}</button>
    </div>
    <VerdictBox v-if="verdict !== null" :verdict="verdict" />
  </div>
</template>

<style scoped>
.work {
  flex: 1;
  overflow-y: auto;
  padding: 12px 28px 110px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.case {
  background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  border-left: 3px solid var(--accent);
  padding: 10px 14px 11px;
}
.brief {
  font-size: calc(16px * var(--fs-scale));
  line-height: 1.7;
  max-width: 60ch;
}
.box {
  border: 1px solid var(--rule);
  background: var(--surface);
}
.box:not(.warn):focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}
/* 差し戻しの枠。橙のみ、赤は使わない。 */
.box.warn {
  border-color: var(--warn);
}
.submit-area {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  display: block;
  background: transparent;
  color: var(--fg);
  border: 0;
  padding: 13px;
  font-family: var(--font-num);
  font-size: calc(14px * var(--fs-scale));
  line-height: 1.7;
}
.row-end {
  display: flex;
  justify-content: flex-end;
}
</style>
