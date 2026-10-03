<script setup lang="ts">
import type { Countdown, MissionFacts } from "./mission-bar-view.js";

/*
 * The mission bar at the top of the centre pane (mock .case.slim + .s2-hd): the stage's title,
 * how many are done, and the countdown. What to show is decided in mission-bar-view.ts.
 */
defineProps<{
  facts: MissionFacts;
  /** `null` when the stage has no deadline on screen. */
  countdown: Countdown | null;
}>();
</script>

<template>
  <div class="mission" data-testid="mission-bar">
    <div class="case slim">
      <div class="stage-title">{{ facts.title }}</div>
    </div>
    <div v-if="facts.count !== null || countdown !== null" class="s2-hd">
      <div v-if="facts.count !== null" class="s2-count">
        {{ facts.count.label }}<b>{{ facts.count.value }}</b>
      </div>
      <div class="grow"></div>
      <span v-if="countdown !== null && facts.deadline?.label" class="dl-label">{{
        facts.deadline.label
      }}</span>
      <div
        v-if="countdown !== null"
        class="s2-timer"
        :class="{ hot: countdown.hot, over: countdown.over }"
        data-testid="mission-countdown"
      >
        {{ countdown.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.mission {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 28px 0;
}
/* 案件カード（mock .case）。Stage 1 と受信トレイは課題文を持たないので上下を詰めた1行の帯。 */
.case {
  background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  border-left: 3px solid var(--accent);
  padding: 10px 14px 11px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition:
    background-color 0.78s ease,
    border-color 0.78s ease;
}
.case.slim {
  padding-top: 3px;
  padding-bottom: 4px;
}
.stage-title {
  font-size: calc(22px * var(--fs-scale));
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 9px;
}
.stage-title::before {
  content: "▸";
  color: var(--accent);
}
.s2-hd {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.s2-hd .grow {
  flex: 1;
}
.s2-count {
  font-family: var(--font-num);
  font-size: 14px;
  color: var(--fg-muted);
}
/* 見出しと数の間はモックの全角空白1つ分。 */
.s2-count b {
  margin-left: 1em;
  color: var(--fg);
  font-size: 19px;
  font-weight: 700;
}
.dl-label {
  font-size: 14px;
  color: var(--fg-muted);
}
.s2-timer {
  font-family: var(--font-num);
  font-size: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
/* 締切が迫っても橙まで。赤は急変に取ってある。 */
.s2-timer.hot {
  color: var(--warn);
}
</style>
