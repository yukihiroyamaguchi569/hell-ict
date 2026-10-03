<script setup lang="ts">
import { stage6JimuCall } from "@hell-ict/content";

import type { ChatReplyImage } from "../../chat/pane-items.js";
import CallWindow from "../common/CallWindow.vue";

/*
 * Stage 6's windows in the stage layer: 事務長's call on entering (mock #ov-s6jimu-task) and the
 * enlarged poster (mock #ov-lightbox, closed by its ✕ or the dark around the picture).
 */
defineProps<{
  taskOpen: boolean;
  zoomed: ChatReplyImage | null;
}>();
const emit = defineEmits<{ closeTask: []; closeZoom: [] }>();
</script>

<template>
  <CallWindow
    v-if="taskOpen"
    :call="stage6JimuCall.call"
    :org="stage6JimuCall.org"
    :lines="stage6JimuCall.lines"
    :close-label="stage6JimuCall.close"
    testid="s6-task"
    @close="emit('closeTask')"
  />
  <div
    v-else-if="zoomed !== null"
    class="veil lightbox"
    data-testid="s6-lightbox"
    @click.self="emit('closeZoom')"
  >
    <button type="button" class="close" aria-label="閉じる" @click="emit('closeZoom')">×</button>
    <img :src="zoomed.src" :alt="zoomed.alt" />
  </div>
</template>

<style scoped>
.lightbox {
  background: rgba(8, 9, 10, 0.88);
}
.lightbox img {
  max-height: 90vh;
  max-width: 90vw;
  width: auto;
  height: auto;
  object-fit: contain;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
}
.close {
  position: absolute;
  top: 18px;
  right: 22px;
  width: 36px;
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  background: transparent;
  color: #fff;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.close:hover {
  background: rgba(255, 255, 255, 0.12);
}
</style>
