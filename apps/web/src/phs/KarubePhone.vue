<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

import { isImeComposing } from "../ime-composing.js";
import type { KarubeLine } from "./use-karube.js";

/*
 * 苅部さん's window (mock `.phs`, index.html 1486-1500 and its CSS 567-588): a bar 400px from
 * the screen's right edge (just left of the AI chat), with the window above it. It floats beside
 * the AI chat, never over it: the two must not read as the same place.
 */
const props = defineProps<{
  open: boolean;
  badge: number | null;
  log: readonly KarubeLine[];
}>();
const emit = defineEmits<{ toggle: []; reply: [text: string] }>();

/** The mock's heading, full-width space included (escaped: the linter forbids it raw). */
const who = "情シス　苅部";
const draft = ref("");
const logEl = ref<HTMLElement | null>(null);

watch(
  () => props.log.length,
  async () => {
    await nextTick();
    if (logEl.value !== null) logEl.value.scrollTop = logEl.value.scrollHeight;
  },
);

const send = (): void => {
  emit("reply", draft.value);
  draft.value = "";
};
const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === "Enter" && !isImeComposing(event)) send();
};
</script>

<template>
  <div class="phs" data-testid="karube-phone">
    <div v-if="open" class="win" data-testid="karube-window">
      <div class="who">{{ who }}</div>
      <div ref="logEl" class="log" data-testid="karube-log">
        <p v-for="line in log" :key="line.key" :class="line.kind">
          {{ line.kind === "me" ? `〔あなた〕${line.text}` : line.text }}
        </p>
      </div>
      <div class="cmp">
        <input v-model="draft" aria-label="苅部さんへの返信" @keydown="onKeydown" />
        <button type="button" @click="send">送信</button>
      </div>
    </div>
    <button type="button" class="bar" @click="emit('toggle')">
      <span>💬</span><span class="grow">メッセージ</span>
      <span v-if="badge !== null" class="badge" data-testid="karube-badge">{{ badge }}</span>
    </button>
  </div>
</template>

<style scoped>
/* The bar sits on the screen's bottom edge, and the window sits right on top of it. Both are
   aligned to the right edge, so opening the (wider) window does not move the bar. */
.phs {
  position: absolute;
  right: 400px;
  bottom: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-family: var(--font-legacy);
  /* The empty corner left of the bar, under the open window, must let clicks through. */
  pointer-events: none;
}
.phs > * {
  pointer-events: auto;
}
.bar {
  width: 220px;
  height: 44px;
  background: var(--phs);
  color: #fff;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  font-size: calc(14px * var(--fs-scale));
  border: 0;
  text-align: left;
  cursor: pointer;
}
.grow {
  flex: 1;
}
.badge {
  background: #d81f2a;
  color: #fff;
  font-family: var(--font-num);
  font-size: 12px;
  font-weight: 700;
  padding: 1px 7px;
  animation: pulse 1.1s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
/* The open window may cover Stage 2 and 3's action row (［提出する］); closing it frees the row. */
.win {
  width: 320px;
  background: #fff;
  color: #16181a;
  border: 1px solid var(--phs);
  border-top: 0;
}
.who {
  padding: 8px 12px;
  font-size: calc(13px * var(--fs-scale));
  border-bottom: 1px solid #cfd6d1;
  background: #eef3ef;
}
.log {
  height: 232px;
  overflow-y: auto;
  padding: 12px;
  font-size: calc(14px * var(--fs-scale));
  line-height: 1.85;
}
.log p {
  margin: 0 0 10px;
}
.log .wait {
  color: #6b736e;
}
.log .me {
  text-align: right;
}
.cmp {
  display: flex;
  border-top: 1px solid #cfd6d1;
}
.cmp input {
  flex: 1;
  border: 0;
  padding: 10px;
  font-family: var(--font-legacy);
  font-size: calc(14px * var(--fs-scale));
  background: #fff;
  color: #16181a;
}
.cmp button {
  border: 0;
  border-left: 1px solid #cfd6d1;
  background: #eef3ef;
  color: #16181a;
  padding: 10px 15px;
  font-family: var(--font-legacy);
  font-size: 14px;
}
</style>
