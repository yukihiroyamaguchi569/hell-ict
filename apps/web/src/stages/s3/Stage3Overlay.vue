<script setup lang="ts">
import {
  stage3Calls,
  stage3NoticeLines,
  stage3Penalty,
  stage3TrapDoctorLines,
} from "@hell-ict/content";
import { computed } from "vue";

import { portraitSrc } from "../../overlays/clear-sheets.js";
import CallWindow from "../common/CallWindow.vue";
import PenaltyLock from "../penalty/PenaltyLock.vue";
import { shelfCount, shelfWards } from "./bottles.js";
import type { BottlePenalty } from "./use-bottle-penalty.js";
import type { Stage3 } from "./use-stage3.js";

/*
 * Stage 3's windows in the stage layer: the director's notice, the trap's blackout (no words:
 * the dermatologist says what happened) and call, and the bottle penalty (mock drawBottles).
 */
const props = defineProps<{ stage: Stage3; penalty: BottlePenalty }>();
const { overlay, penaltyDoneShown } = props.stage;
const { shelf, note, freshWard, elapsedMs, failed, fill, retry } = props.penalty;
const wards = computed(() => shelfWards(shelf.value));
const bottleSrc = portraitSrc(stage3Penalty.bottleImg);
const tag = (state: string, ward: string): string => {
  if (state === "done") return "済";
  return state === "filling" ? "…" : ward;
};
</script>

<template>
  <CallWindow
    v-if="overlay === 'notice'"
    :call="stage3Calls.notice"
    :lines="stage3NoticeLines"
    :close-label="stage3Calls.close"
    @close="stage.dismissNotice"
  />
  <div v-else-if="overlay === 'blackout'" class="veil blackout" data-testid="s3-blackout"></div>
  <CallWindow
    v-else-if="overlay === 'scold'"
    :call="stage3Calls.scold"
    :lines="stage3TrapDoctorLines"
    :close-label="stage3Calls.close"
    @close="stage.dismissScold"
  />
  <PenaltyLock
    v-else-if="overlay === 'penalty'"
    :heading="stage3Penalty.heading"
    :elapsed-ms="elapsedMs"
    :done="penaltyDoneShown"
    wide
  >
    <div class="ptop">
      <div class="note" :class="{ flash: freshWard !== null }">
        <img :src="portraitSrc(stage3Penalty.noteImg)" alt="" />
        <span data-testid="bottle-note">{{ note }}</span>
      </div>
      <div class="stat" data-testid="bottle-stat">{{ shelfCount(shelf) }}</div>
    </div>
    <div class="bottles">
      <div v-for="w in wards" :key="w.ward" class="ward" :class="{ fresh: w.ward === freshWard }">
        <div class="wname">{{ w.ward }}病棟</div>
        <div class="row">
          <button
            v-for="b in w.items"
            :key="b.index"
            type="button"
            :class="b.state === 'todo' ? '' : b.state"
            :disabled="b.state !== 'todo'"
            data-testid="bottle"
            @click="fill(b.index)"
          >
            <img :src="bottleSrc" alt="" />
            <span class="tag">{{ tag(b.state, b.ward) }}</span>
          </button>
        </div>
      </div>
    </div>
    <div v-if="failed" class="retry">
      <button type="button" class="btn" @click="retry">{{ stage3Penalty.retry }}</button>
    </div>
  </PenaltyLock>
</template>

<style scoped>
.blackout {
  background: #050607;
}
.ptop {
  display: flex;
  align-items: center;
  gap: 16px;
}
.note {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.note img {
  height: 54px;
}
.note.flash {
  animation: noteFlash 1.1s ease 1;
}
@keyframes noteFlash {
  22%,
  62% {
    color: var(--warn);
  }
}
.stat {
  font-size: 19px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bottles {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 10px 2px 0;
}
.wname {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--fg-muted);
  margin-bottom: 4px;
}
.row {
  display: grid;
  grid-template-columns: repeat(20, 1fr);
  gap: 6px;
}
.ward.fresh {
  animation: wardIn 0.45s ease both;
}
@keyframes wardIn {
  from {
    opacity: 0;
    transform: translateY(-12px);
  }
}
.row button {
  position: relative;
  aspect-ratio: 1 / 1.7;
  background: var(--bg);
  border: 1px solid var(--rule);
  color: var(--fg-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.row button img {
  width: 62%;
  height: 82%;
  object-fit: contain;
  opacity: 0.28;
  pointer-events: none;
}
.row button.filling {
  border-color: var(--warn);
  color: var(--warn);
}
.row button.filling img {
  opacity: 0.5;
}
.row button.done {
  background: var(--surface-2);
  color: var(--ok);
  border-color: var(--ok);
}
.row button.done img {
  opacity: 0.85;
}
.row button:hover:not(:disabled) {
  border-color: var(--warn);
  color: var(--fg);
}
.tag {
  position: absolute;
  left: 0;
  right: 0;
  top: 66%;
  transform: translateY(-50%);
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  text-shadow:
    0 0 3px var(--bg),
    0 0 6px var(--bg);
}
.row button.done .tag {
  text-shadow:
    0 0 4px var(--surface-2),
    0 0 8px var(--surface-2);
}
.retry {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
}
</style>
