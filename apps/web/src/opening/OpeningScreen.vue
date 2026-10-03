<script setup lang="ts">
import { opening } from "@hell-ict/content";
import { computed } from "vue";

import { loadingText } from "./opening-view.js";
import { OPENING_BACKDROP } from "./preload-manifest.js";

/*
 * The opening (Issue #379): the hospital over the whole screen, and the loading bar while the
 * game's assets load. App.vue decides when it goes; this only draws how far the loading is.
 */
const props = defineProps<{
  /** 0〜100 (`progressPercent`). */
  percent: number;
}>();

const text = computed(() => loadingText(props.percent));
</script>

<template>
  <div class="veil opening" data-testid="opening">
    <img class="art" :src="OPENING_BACKDROP" :alt="opening.alt" />
    <div class="band">
      <div
        class="track"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent"
        :aria-label="opening.loading"
      >
        <div class="fill" :style="{ transform: `scaleX(${String(percent / 100)})` }"></div>
      </div>
      <div class="label" role="status">{{ text }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 全画面の一枚絵の下端に、クリア演出②③と同じ暗いグラデーションを敷いて帯と文字を置く。
   テーマに追従しない固定色（絵の上に載るため）。帯の色だけトークンの --accent を使う。 */
.opening {
  background: #000;
}
.opening .art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.opening .band {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 120px 72px 48px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0) 100%);
  color: #fff;
}
/* 帯は幅を固定し、伸びる見た目は scaleX で作る（クリア演出①の帯と同じ作り）。 */
.opening .track {
  width: 480px;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.22);
  overflow: hidden;
}
.opening .fill {
  height: 100%;
  background: var(--accent);
  transform-origin: left;
  transition: transform 0.2s ease-out;
}
.opening .label {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  color: #e8ecef;
}
</style>
