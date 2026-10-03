<script setup lang="ts">
import { chatPaneText } from "@hell-ict/content";
import { computed, ref, watch } from "vue";

import { replyParts } from "./chat-view.js";
import type { ChatReplyImage } from "./pane-items.js";

/*
 * One bubble of the AI pane (mock aiBubble). The AI's text keeps its tabs from the first line
 * holding one (mock liveReplyHtml): a table the team copies must keep its columns.
 */
const props = defineProps<{
  who: keyof typeof chatPaneText.who;
  text: string;
  /** The greeting (mock `.bubble.empty`): drawn as an AI bubble, never sent or stored. */
  greeting?: boolean;
  /** Answered on the screen, not by the AI: marked 「台本」 by the name (mock `.scripted`). */
  scripted?: boolean;
  /** A picture under the lead (Stage 6's poster, mock `.s6-img`). */
  image?: ChatReplyImage | undefined;
  /** A wait with a bar that fills in this many ms (Stage 6's generation, mock `.s6-wait`). */
  progressMs?: number | undefined;
}>();
/**
 * `action`: a button between the lead (or the picture) and the table (Stage 2's ［表に送る］,
 * mock `.to-grid`; Stage 6's ［これを提出候補にする］).
 */
defineSlots<{ action?: () => unknown }>();

const parts = computed(() =>
  props.who === "assistant" ? replyParts(props.text) : { lead: [props.text], table: null },
);
const lead = computed(() => parts.value.lead.join("\n"));

/** The picture failed to load: its alt stands in (mock `.s6-fallback`). Another picture retries. */
const broken = ref(false);
watch(
  () => props.image?.src,
  () => {
    broken.value = false;
  },
);
</script>

<template>
  <div
    class="bubble"
    :class="{ me: who === 'user', empty: greeting === true, scripted: scripted === true }"
    :data-who="who"
    data-testid="chat-bubble"
  >
    <div class="who">
      {{ chatPaneText.who[who]
      }}<span v-if="scripted === true" class="tag">{{ chatPaneText.scriptedTag }}</span>
    </div>
    <div class="body" :class="{ wait: progressMs !== undefined }">
      <div v-if="lead !== ''" class="lead">{{ lead }}</div>
      <span v-if="progressMs !== undefined" class="bar" data-testid="chat-progress"
        ><i :style="{ animationDuration: `${String(progressMs)}ms` }"></i
      ></span>
      <template v-if="image !== undefined">
        <div v-if="broken" class="img-missing" data-testid="chat-image-missing">
          {{ chatPaneText.imageMissing(image.alt) }}
        </div>
        <img
          v-else
          class="img"
          :src="image.src"
          :alt="image.alt"
          data-testid="chat-image"
          @error="broken = true"
        />
      </template>
      <slot name="action" />
      <pre v-if="parts.table !== null" class="tsv">{{ parts.table }}</pre>
    </div>
  </div>
</template>

<style scoped>
.bubble {
  font-size: calc(16px * var(--fs-scale));
  line-height: 1.7;
}
.who {
  font-size: calc(12px * var(--fs-scale));
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--ai-muted);
  margin-bottom: 5px;
}
/* 台本応答の印は名前の隣へ小さく、灰色で（右端は画面の端と重なるので寄せない）。 */
.bubble.scripted .who {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.bubble.scripted .tag {
  font-weight: 400;
  letter-spacing: 0.04em;
  opacity: 0.6;
}
.bubble.me .body {
  background: var(--ai-surface-2);
  padding: 11px 13px;
}
/* 改行だけを保つ（モックは改行を <br> にしていた）。 */
.lead {
  white-space: pre-line;
  overflow-wrap: anywhere;
}
/* 生成待ちの文言の右で、バーが待ち時間いっぱいで伸びきる（モック .s6-wait）。 */
.body.wait {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
  color: var(--ai-muted);
}
.bar {
  flex: 1;
  height: 4px;
  background: var(--ai-rule);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  width: 0;
  background: var(--ai-fg);
  animation-name: fill;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
@keyframes fill {
  to {
    width: 100%;
  }
}
/* 画像はペインの幅に対して小さく置く（モック .s6-img）。拡大表示は V8 が持つ。 */
.img {
  display: block;
  width: 100%;
  max-width: 220px;
  border: 1px solid var(--ai-rule);
}
.img-missing {
  padding: 9px 10px;
  background: var(--ai-surface-2);
  color: var(--ai-muted);
}
/* white-space: pre でタブと改行をそのまま保つ——潰れると、選択してコピーした表の区切りが
   失われる。折り返さず横スクロールで受ける（折り返すとコピーの改行位置がずれる）。 */
.tsv {
  margin: 8px 0 0;
  padding: 9px 10px;
  background: var(--ai-surface-2);
  font-family: var(--font-num);
  font-size: 13px;
  line-height: 1.75;
  white-space: pre;
  overflow-x: auto;
  tab-size: 10;
  -moz-tab-size: 10;
}
</style>
