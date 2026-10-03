<script setup lang="ts">
import {
  stage3Brief,
  stage3FieldLabels,
  stage3FieldPlaceholders,
  stage3SubmitLabel,
} from "@hell-ict/content";
import { STAGE3_FIELD_IDS } from "@hell-ict/domain";

import VerdictBox from "../../verdict/VerdictBox.vue";
import type { Stage3 } from "./use-stage3.js";

/*
 * Stage 3's centre pane (mock renderStage3): the task, the three fields in the judge's order and
 * the submission. While a submission is judged the fields are read-only (the verdict must be about
 * the words on screen) and the button is gone; it stays gone once the stage is cleared.
 */
const props = defineProps<{ stage: Stage3 }>();
const { draft, verdict, warnField, submitting } = props.stage;
const onSubmit = (): void => {
  void props.stage.submit();
};
</script>

<template>
  <div class="work">
    <div class="case">
      <div class="brief">{{ stage3Brief }}</div>
    </div>
    <div
      v-for="field in STAGE3_FIELD_IDS"
      :key="field"
      class="box"
      :class="{ warn: warnField === field }"
      :data-testid="`s3-box-${field}`"
    >
      <label class="hd" :for="`s3-${field}`">{{ stage3FieldLabels[field] }}</label>
      <textarea
        :id="`s3-${field}`"
        v-model="draft[field]"
        :readonly="submitting"
        class="submit-area"
        :placeholder="stage3FieldPlaceholders[field]"
      ></textarea>
    </div>
    <div v-if="!submitting && verdict?.kind !== 'cleared'" class="row-end">
      <button type="button" class="btn" @click="onSubmit">{{ stage3SubmitLabel }}</button>
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
.box > .hd {
  display: block;
  padding: 8px 13px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--fg-note);
  border-bottom: 1px solid var(--rule);
}
.box:not(.warn):focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}
/* 差し戻し（不足）の枠。橙のみ、赤は使わない。 */
.box.warn {
  border-color: var(--warn);
}
.box.warn > .hd {
  color: var(--warn);
}
.submit-area {
  width: 100%;
  min-height: 70px;
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
.submit-area::placeholder {
  color: var(--fg-note);
}
.row-end {
  display: flex;
  justify-content: flex-end;
}
</style>
