<script setup lang="ts">
import { stage6Brief, stage6Labels, stage6NoCandidateLines } from "@hell-ict/content";
import { ref, watch } from "vue";

import type { ChatReplyImage } from "../../chat/pane-items.js";
import VerdictBox from "../../verdict/VerdictBox.vue";
import type { Stage6 } from "./use-stage6.js";

/*
 * Stage 6's centre pane (mock renderStage6 and s6DrawCandidate): the brief, the candidate picked
 * in the chat on the right, and its submission. Only the picture is shown, never its prompt (a
 * long prompt overflows the box).
 */
const props = defineProps<{
  s6: Stage6;
  /** Opens the picture enlarged (mock openLightbox). */
  zoom: (image: ChatReplyImage) => void;
}>();
const { selected, submitting, warn, verdict, cleared, submit } = props.s6;

/** The picture failed to load: its alt stands in (mock `.thumb-fallback`). */
const broken = ref(false);
watch(
  () => selected.value?.image.src,
  () => {
    broken.value = false;
  },
);
</script>

<template>
  <div class="work" data-testid="s6-center">
    <div class="brief">{{ stage6Brief }}</div>
    <div class="box cand" :class="{ warn }" data-testid="s6-candidate">
      <div v-if="selected === null" class="empty">
        <div v-for="(line, i) in stage6NoCandidateLines" :key="i">{{ line }}</div>
      </div>
      <div v-else-if="broken" class="thumb-fallback">［{{ selected.image.alt }}］</div>
      <button v-else type="button" class="zoom" @click="zoom(selected.image)">
        <img
          class="thumb"
          :src="selected.image.src"
          :alt="selected.image.alt"
          data-testid="s6-thumb"
          @error="broken = true"
        />
      </button>
    </div>
    <div class="row-end">
      <button
        type="button"
        class="btn"
        :disabled="selected === null || submitting || cleared"
        @click="submit"
      >
        {{ stage6Labels.submit }}
      </button>
    </div>
    <VerdictBox v-if="verdict !== null" :verdict="verdict" />
  </div>
</template>

<style scoped>
.work {
  flex: 1;
  overflow-y: auto;
  padding: 12px 28px 110px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.brief {
  font-size: calc(16px * var(--fs-scale));
  line-height: 1.7;
  max-width: 60ch;
}
.box {
  border: 1px solid var(--rule);
  background: var(--surface);
}
.box.warn {
  border-color: var(--warn);
}
.cand {
  padding: 14px;
  display: flex;
  gap: 14px;
  align-items: flex-start;
  min-height: 120px;
}
.empty {
  color: var(--fg-note);
  font-size: calc(15px * var(--fs-scale));
  line-height: 1.7;
}
.zoom {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}
.thumb {
  display: block;
  width: 120px;
  height: 120px;
  object-fit: cover;
  border: 1px solid var(--rule);
  background: var(--surface-2);
}
.thumb-fallback {
  width: 120px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-note);
  border: 1px dashed var(--rule);
  padding: 8px;
}
</style>
