<script setup lang="ts">
import type { RedBandPhase } from "../composables/use-red-band.js";

/*
 * The red band under the header (mock .redband). Its timing lives in use-red-band; this only
 * slides it in and fades it out. It sits under the overlays (z-index 55 < the veils' 60).
 */
defineProps<{
  phase: RedBandPhase;
  text: string;
}>();
</script>

<template>
  <div
    v-if="phase !== 'hidden'"
    class="redband"
    :class="phase"
    role="status"
    data-testid="red-band"
  >
    {{ text }}
  </div>
</template>

<style scoped>
/* 急変：赤帯は数秒で消える。赤は使い減りする資源として扱う。 */
.redband {
  position: absolute;
  left: 0;
  right: 0;
  top: 56px;
  z-index: 55;
  background: var(--accent);
  color: #fff;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 15px 24px;
  transform: translateX(-100%);
}
.redband.in {
  animation: band-in 0.28s ease-out forwards;
}
.redband.out {
  animation: band-out 0.4s ease-in forwards;
}
@keyframes band-in {
  to {
    transform: translateX(0);
  }
}
@keyframes band-out {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(0);
    opacity: 0;
  }
}
</style>
