<script setup lang="ts">
import { verdictCheckingText } from "@hell-ict/content";

import type { Verdict } from "./verdict.js";

/*
 * The verdict under a submission (mock `.verdict`, index.html 446-474). The checking line stays
 * on top, and its spinner stops once a result row is under it. A result row fades in each time,
 * so a rejection with the same words as the last one still shows that it was checked again
 * (issue #69).
 */
defineProps<{ verdict: Verdict }>();
</script>

<template>
  <div class="verdict" data-testid="verdict" aria-live="polite">
    <div class="lead checking">{{ verdictCheckingText }}</div>
    <template v-if="verdict.kind === 'rejected'">
      <div v-for="(line, i) in verdict.lines" :key="i" class="lead">{{ line }}</div>
    </template>
    <div v-else-if="verdict.kind === 'cleared'" class="done">{{ verdict.text }}</div>
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
