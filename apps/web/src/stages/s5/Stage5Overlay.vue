<script setup lang="ts">
import {
  stage5Alarm,
  stage5Call,
  stage5CallLines,
  stage5IncidentReport,
  stage5Penalty,
  stage5ScoldLines,
} from "@hell-ict/content";
import { nextTick, useTemplateRef, watch } from "vue";

import VerdictBox from "../../verdict/VerdictBox.vue";
import CallWindow from "../common/CallWindow.vue";
import PenaltyLock from "../penalty/PenaltyLock.vue";
import type { RedactPenalty } from "./use-redact-penalty.js";
import type { Stage5 } from "./use-stage5.js";

/*
 * Stage 5's windows in the stage layer: the trap's alarm (facts only, no blame and no comfort)
 * and the head of administration's scold, the blacked-out report (mock startS5Penalty), and the
 * deadline's call. Which one shows is `Stage5.overlay`'s; the report covers the AI chat, which
 * is the penalty's lock (mock .pane-r.locked).
 */
const props = defineProps<{ stage: Stage5; penalty: RedactPenalty }>();
const { overlay } = props.stage;
const { masked, sending, verdict, elapsedMs, holding } = props.penalty;

const verdictEl = useTemplateRef<HTMLElement>("verdictEl");
// The verdict is under the report, below the fold of the penalty's box: scroll the box (the
// slot's parent in PenaltyLock) to its bottom, as the mock's submitReport scrolls #penalty-host.
// Not scrollIntoView: it scrolls the screen behind as well, which pushes the box under the heading.
watch(verdict, () => {
  void nextTick(() => {
    const box = verdictEl.value?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  });
});
</script>

<template>
  <div v-if="overlay === 'alarm'" class="veil alarm" data-testid="s5-alarm" role="alert">
    <div class="t">{{ stage5Alarm.title }}</div>
    <div class="s">{{ stage5Alarm.sub }}</div>
  </div>
  <CallWindow
    v-else-if="overlay === 'scold'"
    testid="s5-scold"
    :call="stage5Call"
    :org="stage5Call.org"
    :lines="stage5ScoldLines"
    :close-label="stage5Call.close"
    @close="stage.dismissScold"
  />
  <PenaltyLock
    v-else-if="overlay === 'penalty'"
    :heading="stage5Penalty.heading"
    :elapsed-ms="elapsedMs"
    :done="holding"
    wide
  >
    <div class="note">{{ stage5Penalty.note }}</div>
    <div class="report" data-testid="s5-report">
      <template v-for="(seg, i) in stage5IncidentReport" :key="i">
        <button
          v-if="seg.pii !== undefined"
          type="button"
          class="tok"
          :class="{ masked: masked.has(i) }"
          :aria-pressed="masked.has(i)"
          @click="penalty.toggle(i)"
          v-text="seg.t"
        ></button>
        <template v-else>{{ seg.t }}</template>
      </template>
    </div>
    <div class="row-end">
      <button type="button" class="btn" :disabled="sending || holding" @click="penalty.submit">
        {{ stage5Penalty.submit }}
      </button>
    </div>
    <div ref="verdictEl">
      <VerdictBox v-if="verdict !== null" :verdict="verdict" />
    </div>
  </PenaltyLock>
  <CallWindow
    v-else-if="overlay === 'call'"
    testid="s5-call"
    :call="stage5Call"
    :org="stage5Call.org"
    :lines="stage5CallLines"
    :close-label="stage5Call.close"
    @close="stage.dismissCall"
  />
</template>

<style scoped>
.alarm {
  background: var(--accent);
  flex-direction: column;
  gap: 8px;
  animation: alarmFlash 0.5s ease-in-out 3;
}
@keyframes alarmFlash {
  0%,
  100% {
    background: var(--accent);
  }
  50% {
    background: #050607;
  }
}
.alarm .t {
  font-size: 26px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.03em;
}
.alarm .s {
  font-size: 16px;
  color: #fff;
  opacity: 0.92;
}
.note {
  font-size: 13px;
  margin-bottom: 10px;
}
.report {
  font-family: var(--font-legacy);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.tok {
  border: 1px dashed var(--warn);
  padding: 0 3px;
  cursor: pointer;
  background: transparent;
  color: inherit;
  font: inherit;
}
.tok:hover {
  background: rgba(217, 154, 31, 0.14);
}
.tok.masked {
  background: #16181a;
  color: #16181a;
  border-color: #16181a;
}
.row-end {
  display: flex;
  justify-content: flex-end;
  padding: 12px 0;
}
</style>
