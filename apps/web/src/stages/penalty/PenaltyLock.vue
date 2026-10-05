<script setup lang="ts">
import { penaltyDoneText } from "@hell-ict/content";

import { penaltyClockText } from "./penalty-clock.js";

/*
 * The penalty's frame (mock #ov-lock), shared by the trap stages: Stage 3's bottles now, Stage 5's
 * blacked-out report later. The heading and the clock of the time paid are the frame's; the work
 * goes in the slot. `wide` is the bottle shelf's and the report's size (mock .box.shelf / .paper).
 * `done`: the penalty is paid and the window is about to close (PENALTY_DONE_MS) — a word of
 * encouragement under the clock, the work left as it was.
 */
defineProps<{ heading: string; elapsedMs: number; wide?: boolean; done?: boolean }>();
</script>

<template>
  <div class="veil lock" data-testid="penalty-lock">
    <div class="hd">{{ heading }}</div>
    <div class="timer" data-testid="penalty-clock">{{ penaltyClockText(elapsedMs) }}</div>
    <div v-if="done" class="done" data-testid="penalty-done" role="status">
      {{ penaltyDoneText }}
    </div>
    <div class="box" :class="{ wide }"><slot /></div>
  </div>
</template>

<style scoped>
.lock {
  background:
    repeating-linear-gradient(
      135deg,
      rgba(217, 154, 31, 0.16) 0 18px,
      rgba(217, 154, 31, 0.05) 18px 36px
    ),
    rgba(8, 9, 10, 0.88);
  flex-direction: column;
  gap: 16px;
  padding: 34px;
}
.hd {
  font-size: 36px;
  line-height: 1.15;
  font-weight: 700;
  color: var(--warn);
  letter-spacing: 0.03em;
}
.timer {
  font-family: var(--font-num);
  font-size: 46px;
  font-weight: 700;
  color: #fff;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.done {
  font-size: 30px;
  font-weight: 700;
  color: #fff;
  background: var(--ok);
  padding: 10px 26px;
  border-radius: 6px;
  animation: penaltyDoneIn 0.32s ease both;
}
@keyframes penaltyDoneIn {
  from {
    opacity: 0;
    transform: scale(0.92);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .done {
    animation: none;
  }
}
.box {
  width: 100%;
  max-width: 880px;
  background: var(--surface);
  color: var(--fg);
  border: 1px solid var(--rule);
  padding: 14px;
  max-height: 56vh;
  overflow: auto;
}
.box.wide {
  max-width: 1040px;
  max-height: 520px;
}
</style>
