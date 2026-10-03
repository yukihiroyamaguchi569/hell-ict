<script setup lang="ts">
import type { GameStageId } from "@hell-ict/domain";

import { useAppContext } from "../app-context.js";
import { dueBarWidth, type InboxView } from "./inbox-view.js";
import { useLandingRows } from "./use-landing-rows.js";

/*
 * The inbox in the left pane (mock #mails and the heading's #unread). Rows are keyed by the
 * mail's id, so the stage's 250 ms redraw patches the rows in place: rebuilding them made a
 * press that spanned a redraw get lost (mock, 2026-09-23). What a press does is inbox-view's call.
 * A row that was not in the previous draw shakes once as it lands (inbox-view's landingIds).
 */
const props = defineProps<{
  view: InboxView;
  /** The stage on screen: a stage change is a first draw, nothing lands. */
  stage: GameStageId;
}>();

const landing = useLandingRows(
  () => ({ stage: props.stage, ids: props.view.items.map((item) => item.row.id) }),
  useAppContext().scheduler,
);

defineEmits<{
  open: [id: string];
}>();
</script>

<template>
  <div class="pane-hd">
    受信トレイ
    <span v-if="view.unread > 0" class="count" data-testid="inbox-unread">{{ view.unread }}</span>
  </div>
  <div class="mails" data-testid="inbox-list">
    <button
      v-for="item in view.items"
      :key="item.row.id"
      type="button"
      class="mail"
      :class="{
        read: item.read,
        done: item.row.closed,
        hot: item.row.due?.hot,
        pinned: item.row.pinned,
        landing: landing.has(item.row.id),
      }"
      :aria-current="item.current"
      :data-mail-id="item.row.id"
      @click="$emit('open', item.row.id)"
    >
      <div class="from">{{ item.row.from }}</div>
      <div class="subj">{{ item.row.subject }}</div>
      <div v-if="item.row.attach" class="attach">📎 {{ item.row.attach }}</div>
      <div v-if="item.row.due" class="due">
        <span>{{ item.row.due.text }}</span>
        <span v-if="item.row.due.ratio !== null" class="bar"
          ><i :style="{ width: dueBarWidth(item.row.due.ratio) }"></i
        ></span>
      </div>
    </button>
  </div>
</template>

<style scoped>
.count {
  font-family: var(--font-num);
  background: var(--accent);
  color: #fff;
  padding: 1px 7px;
  font-size: 12px;
  font-weight: 700;
}
.mails {
  overflow-y: auto;
  flex: 1;
}
.mail {
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--rule);
  padding: 11px 14px;
  color: var(--fg);
  display: block;
  transition: border-color 0.78s ease;
}
/* A mail that has just arrived slides in and shakes once (mock .mail.landing). */
@keyframes land {
  0% {
    transform: translateX(-14px);
    opacity: 0;
  }
  55% {
    transform: translateX(4px);
    opacity: 1;
  }
  70% {
    transform: translateX(-3px);
  }
  85% {
    transform: translateX(2px);
  }
  100% {
    transform: translateX(0);
  }
}
.mail.landing {
  animation: land 0.55s ease-out;
}
.mail:hover {
  background: var(--surface-2);
}
.mail[aria-current="true"] {
  background: var(--surface);
  box-shadow: inset 3px 0 0 var(--accent);
}
.from {
  font-size: calc(14px * var(--fs-scale));
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
}
.from::before {
  content: "●";
  font-size: 9px;
  color: var(--accent);
}
.mail.read .from {
  font-weight: 500;
  color: var(--fg-muted);
}
.mail.read .from::before {
  content: "○";
  color: var(--fg-muted);
}
.subj {
  font-size: calc(13px * var(--fs-scale));
  color: var(--fg-muted);
  margin-top: 2px;
  line-height: 1.45;
}
/* The file name is never cut short: 最新版(2)_コピー is the joke. */
.attach {
  font-family: var(--font-legacy);
  font-size: calc(12px * var(--fs-scale));
  color: var(--fg-muted);
  margin-top: 6px;
  word-break: break-all;
  line-height: 1.5;
}
.due {
  font-family: var(--font-num);
  font-size: 12px;
  margin-top: 7px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.bar {
  flex: 1;
  height: 3px;
  background: var(--surface-2);
  position: relative;
}
.bar i {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: var(--ok);
}
.mail.hot .due {
  color: var(--warn);
  font-weight: 700;
}
.mail.hot .bar i {
  background: var(--warn);
}
.mail.done {
  opacity: 0.38;
}
.mail.pinned {
  border-left: 3px solid var(--accent);
}
</style>
