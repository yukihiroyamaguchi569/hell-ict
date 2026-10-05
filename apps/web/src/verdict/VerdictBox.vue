<script setup lang="ts">
import { verdictCheckingText } from "@hell-ict/content";

import type { Verdict } from "./verdict.js";

/*
 * The verdict under a submission (mock `.verdict`, index.html 446-474). The checking line stays
 * on top, and its spinner stops once a result row is under it. A result row fades in each time,
 * so a rejection with the same words as the last one still shows that it was checked again
 * (issue #69). A pass that lists its checks shows them one by one before the success line (mock
 * runVerdict), by CSS animation-delay rather than timers.
 */
defineProps<{ verdict: Verdict }>();
</script>

<template>
  <div class="verdict" data-testid="verdict" aria-live="polite">
    <div class="lead checking">{{ verdictCheckingText }}</div>
    <template v-if="verdict.kind === 'rejected'">
      <div v-for="(line, i) in verdict.lines" :key="i" class="lead">{{ line }}</div>
    </template>
    <template v-else-if="verdict.kind === 'cleared'">
      <div
        v-for="(line, i) in verdict.checks ?? []"
        :key="`check-${String(i)}`"
        class="lead tick"
        :style="{ '--tick': i }"
      >
        {{ line }}
      </div>
      <div
        class="done"
        :class="{ tick: verdict.checks !== undefined }"
        :style="{ '--tick': verdict.checks?.length ?? 0 }"
      >
        {{ verdict.text }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.verdict {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.lead {
  font-size: calc(15px * var(--fs-scale));
  color: var(--fg-note);
}
.done {
  font-size: calc(17px * var(--fs-scale));
  font-weight: 700;
  color: var(--ok);
  padding-top: 6px;
}
.verdict > .lead,
.verdict > .done {
  animation: verdictIn 0.28s ease both;
}
/*
 * A pass's checks and its success line come in turn: the first at 200 ms, then one every 400 ms
 * (Stage 2's success line at 1.8 s). STAGE2_PASS_HOLD_MS holds the clear effect until all are in.
 */
.verdict > .tick {
  animation-delay: calc(200ms + var(--tick) * 400ms);
}
@media (prefers-reduced-motion: reduce) {
  .verdict > .tick {
    animation-delay: 0s;
  }
}
.checking::before {
  content: "";
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 8px;
  vertical-align: -1px;
  border-radius: 50%;
  border: 2px solid var(--fg-note);
  border-top-color: transparent;
  animation: verdictSpin 0.8s linear infinite;
}
/* 結果の行が下に付いたら輪は止める（モックと同じくCSSで自動にする）。 */
.checking:not(:last-child)::before {
  display: none;
}
@keyframes verdictIn {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes verdictSpin {
  to {
    transform: rotate(360deg);
  }
}
</style>
