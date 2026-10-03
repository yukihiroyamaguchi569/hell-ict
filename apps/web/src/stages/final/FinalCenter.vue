<script setup lang="ts">
import {
  FINAL_LINE_MAX,
  finalBoardTiles,
  finalCloseLines,
  finalLabels,
  finalLinePrompt,
} from "@hell-ict/content";
import { computed } from "vue";

import WelcomeScreen from "../../entry/WelcomeScreen.vue";
import { isImeComposing } from "../../ime-composing.js";
import { litTiles, TILE_COUNT } from "./final-view.js";
import type { Final } from "./use-final.js";

/*
 * Final's centre pane (mock renderFinal): the six tiles light one by one, then the piece takes
 * the line for the next team and keeps it on screen (the facilitator reads it out). After
 * ［最初に戻る］ the welcome screen stands in until the team goes on again (decision 14 B).
 */
const props = defineProps<{ final: Final }>();
// The stage's refs, bound once per stay: top-level refs unwrap in the template and take v-model.
const { phase, line, draft, note, pieceOpen } = props.final;

const lit = computed(() => litTiles(phase.value));
const written = computed(() => line.value !== null);
const [closeHead, ...closeRest] = finalCloseLines;

const onKeydown = (event: KeyboardEvent): void => {
  // The Enter that confirms a conversion is not a request to write the line.
  if (event.key !== "Enter" || isImeComposing(event)) return;
  event.preventDefault();
  props.final.writeLine();
};
</script>

<template>
  <WelcomeScreen v-if="phase.kind === 'rest'" @open-inbox="final.resume()" />
  <div v-else class="work" data-testid="final-center">
    <div class="brief">{{ finalLabels.task }}</div>
    <div class="fboard" :class="{ done: written }">
      <div class="ftiles">
        <div
          v-for="(tile, i) in finalBoardTiles"
          :key="tile.id"
          class="ftile"
          :class="{ lit: i < lit }"
          data-testid="final-tile"
        >
          <!-- The icon is the SVG body of a constant in @hell-ict/content, never the team's input. -->
          <!-- eslint-disable vue/no-v-html -- the icon is a content constant, not user input -->
          <svg
            viewBox="0 0 24 24"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            v-html="tile.icon"
          ></svg>
          <!-- eslint-enable vue/no-v-html -->
          <div class="fn">{{ tile.n }}</div>
          <div class="ft-title">{{ tile.achieve }}</div>
        </div>
      </div>
      <div
        class="fpiece"
        :class="{ ready: lit === TILE_COUNT, done: written }"
        data-testid="final-piece"
      >
        <div class="fpiece-label">{{ finalLabels.pieceLabel }}</div>
        <div class="fpiece-body">
          <div v-if="line !== null" class="fpiece-line">{{ line }}</div>
          <template v-else-if="pieceOpen">
            <div class="fpiece-prompt">{{ finalLinePrompt }}</div>
            <input
              v-model="draft"
              type="text"
              :aria-label="finalLabels.pieceLabel"
              :placeholder="finalLabels.linePlaceholder"
              :maxlength="FINAL_LINE_MAX"
              @keydown="onKeydown"
            />
            <div class="row-end">
              <button type="button" class="btn" @click="final.writeLine()">
                {{ finalLabels.write }}
              </button>
            </div>
            <div class="fpiece-note">{{ note }}</div>
          </template>
        </div>
      </div>
    </div>
    <div v-if="written" class="fclose" data-testid="final-close">
      <div class="fclose-head">{{ closeHead }}</div>
      <div v-for="(text, i) in closeRest" :key="i">{{ text }}</div>
    </div>
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
/* The board (mock .fboard): six tiles of what the team made, and the piece left blank. */
.fboard {
  display: flex;
  flex-direction: column;
  gap: 18px;
  align-items: center;
  width: 100%;
}
.ftiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  max-width: 700px;
}
.ftile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid var(--rule);
  background: var(--surface-2);
  opacity: 0.28;
  filter: grayscale(1);
  transition:
    opacity 0.5s ease,
    filter 0.5s ease,
    border-color 0.5s ease;
}
.ftile.lit {
  opacity: 1;
  filter: grayscale(0);
  border-color: var(--accent);
}
.ftile .fn {
  font-family: var(--font-num);
  font-size: 11px;
  color: var(--fg-muted);
  letter-spacing: 0.06em;
}
.ftile.lit .fn {
  color: var(--accent);
}
.ftile svg {
  width: 22px;
  height: 22px;
  stroke: var(--fg-muted);
  fill: none;
}
.ftile.lit svg {
  stroke: var(--accent);
}
.ftile .ft-title {
  font-size: 13px;
  font-weight: 700;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.fpiece {
  width: 100%;
  max-width: 420px;
  border: 1px dashed var(--rule);
  background: var(--surface-2);
  padding: 16px 18px;
  text-align: center;
  opacity: 0.28;
  filter: grayscale(1);
  transition:
    opacity 0.5s ease,
    filter 0.5s ease,
    border-color 0.5s ease;
}
.fpiece.ready {
  opacity: 1;
  filter: grayscale(0);
  border-style: solid;
}
.fpiece.done {
  border-color: var(--accent);
}
.fpiece-label {
  font-size: 12px;
  color: var(--fg-note);
  letter-spacing: 0.08em;
  margin-bottom: 8px;
}
.fpiece-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
}
.fpiece-prompt {
  font-size: 14px;
  color: var(--fg);
  text-align: left;
}
.fpiece-body input {
  font: inherit;
  font-size: 15px;
  padding: 9px 11px;
  border: 1px solid var(--rule);
  background: var(--bg);
  color: var(--fg);
  width: 100%;
}
.fpiece-note {
  font-size: 12px;
  color: var(--warn);
  min-height: 1.4em;
  text-align: left;
}
.fpiece-line {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
/* The board lights up once together when the line is written: no words of celebration. */
.fboard.done .ftile {
  animation: fPulse 0.9s ease-out;
}
@keyframes fPulse {
  0% {
    box-shadow: 0 0 0 rgba(0, 0, 0, 0);
  }
  40% {
    box-shadow: 0 0 0 3px var(--accent);
  }
  100% {
    box-shadow: 0 0 0 rgba(0, 0, 0, 0);
  }
}
.fclose {
  font-size: 15px;
  line-height: 1.9;
  color: var(--fg-note);
  max-width: 56ch;
  text-align: center;
  margin: 4px auto 0;
}
.fclose-head {
  color: var(--fg);
  font-weight: 700;
  margin-bottom: 4px;
}
</style>
