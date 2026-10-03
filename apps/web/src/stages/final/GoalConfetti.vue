<script setup lang="ts">
import { confettiPieces } from "./goal-view.js";

/*
 * The goal's confetti (mock #goal-confetti, goalConfettiBurst): one burst, shown while the Final
 * composable's `confetti` is on. It never takes a click (pointer-events: none), so the goal's
 * button works through it.
 */
const pieces = confettiPieces();
</script>

<template>
  <div class="confetti" aria-hidden="true" data-testid="final-confetti">
    <i
      v-for="(p, i) in pieces"
      :key="i"
      :style="{
        left: `${p.leftPct}%`,
        background: p.color,
        animationDelay: `${p.delayMs}ms`,
        animationDuration: `${p.durationMs}ms`,
        '--rot': `${p.rotDeg}deg`,
        '--drift': `${p.driftPx}px`,
      }"
    ></i>
  </div>
</template>

<style scoped>
.confetti {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.confetti i {
  position: absolute;
  top: -8%;
  width: 9px;
  height: 16px;
  border-radius: 1px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  opacity: 0;
  animation-name: confettiFall;
  animation-timing-function: cubic-bezier(0.35, 0, 0.65, 1);
  animation-fill-mode: forwards;
}
@keyframes confettiFall {
  0% {
    transform: translateY(0) translateX(0) rotate(0deg);
    opacity: 1;
  }
  100% {
    transform: translateY(124vh) translateX(var(--drift, 0px)) rotate(var(--rot, 360deg));
    opacity: 0.85;
  }
}
</style>
