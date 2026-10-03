<script setup lang="ts">
import { shellBrand, shellFeverLabel, shellPlainVitals } from "@hell-ict/content";
import { computed } from "vue";

/*
 * The header (mock .hdr, 56px). The fever count hides among the ordinary figures of the
 * hospital: alone it would be noticed. The header itself is not enlarged by the text size.
 */
const props = defineProps<{
  fever: number;
  /** Only the fever is left, in the accent colour (Stage 3〜6). */
  crescendo: boolean;
  muted: boolean;
  canShrinkFont: boolean;
  canEnlargeFont: boolean;
  /** `--:--` while the clock is not running. */
  clock: string;
  clockIdle: boolean;
  teamName: string;
}>();

defineEmits<{
  toggleMute: [];
  shrinkFont: [];
  enlargeFont: [];
}>();

const muteLabel = computed(() => (props.muted ? "効果音を鳴らす" : "効果音を消す"));
</script>

<template>
  <div class="hdr">
    <div class="brand">
      {{ shellBrand.name }} <span>{{ shellBrand.sub }}</span>
    </div>
    <div class="vitals" :class="{ crescendo }" data-testid="vitals">
      <template v-for="vital in shellPlainVitals" :key="vital">
        <span class="plain">{{ vital }}</span
        ><span class="dot plain">・</span>
      </template>
      <span class="fever"
        >{{ shellFeverLabel }} <b data-testid="fever">{{ fever }}</b></span
      >
    </div>
    <div class="spacer"></div>
    <!-- 会場でファシリテーターが音を切るためのスイッチ。音源を選んで鳴らすUIではない。 -->
    <button
      type="button"
      class="mute"
      :aria-pressed="muted"
      :aria-label="muteLabel"
      :title="muteLabel"
      @click="$emit('toggleMute')"
    >
      {{ muted ? "🔇" : "🔊" }}
    </button>
    <div class="fs" role="group" aria-label="文字サイズ">
      <button
        type="button"
        aria-label="文字を小さく"
        title="文字を小さく"
        :disabled="!canShrinkFont"
        @click="$emit('shrinkFont')"
      >
        A−
      </button>
      <button
        type="button"
        aria-label="文字を大きく"
        title="文字を大きく"
        :disabled="!canEnlargeFont"
        @click="$emit('enlargeFont')"
      >
        A＋
      </button>
    </div>
    <div class="clock" :class="{ idle: clockIdle }" data-testid="clock">{{ clock }}</div>
    <div class="team" data-testid="team-chip">{{ teamName }}</div>
  </div>
</template>

<style scoped>
.hdr {
  height: 56px;
  flex: 0 0 56px;
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 18px;
  background: var(--surface);
  border-bottom: 1px solid var(--rule);
  transition:
    background-color 0.78s ease,
    border-color 0.78s ease;
}
.brand {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.brand span {
  color: var(--fg-muted);
  font-weight: 500;
}

/* 院内状況インジケータ ＝ 通奏低音の実体。平時の指標に紛れ込ませる。 */
.vitals {
  font-family: var(--font-num);
  font-size: 14px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  display: flex;
  gap: 10px;
  align-items: center;
  transition: color 0.78s ease;
}
.vitals .dot {
  opacity: 0.45;
}
.vitals .fever {
  transition:
    color 0.5s ease,
    opacity 0.5s ease;
}
.vitals.crescendo .plain {
  opacity: 0;
}
.vitals.crescendo .fever {
  color: var(--accent);
  font-weight: 700;
}

.spacer {
  flex: 1;
}
.clock {
  font-family: var(--font-num);
  font-size: 32px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  line-height: 1;
}
.clock.idle {
  color: var(--fg-muted);
}
.team {
  font-size: 15px;
  font-weight: 700;
  padding: 5px 11px;
  border: 1px solid var(--rule);
  color: var(--fg-muted);
  transition:
    border-color 0.78s ease,
    color 0.78s ease;
}

/* ミュートと文字サイズは、隣のチーム名チップと同じ枠の見た目に揃えて画面へ溶かす。 */
.mute,
.fs button {
  font-size: 15px;
  line-height: 1;
  padding: 5px 9px;
  background: transparent;
  border: 1px solid var(--rule);
  color: var(--fg-muted);
  transition:
    border-color 0.78s ease,
    color 0.78s ease;
}
.mute:hover,
.fs button:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--fg-muted);
}
.fs {
  display: flex;
  gap: 6px;
}
.fs button:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
