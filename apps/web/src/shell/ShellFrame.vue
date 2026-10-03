<script setup lang="ts">
import type { ShellMode } from "@hell-ict/content";
import { computed, ref } from "vue";

import { useFitScale } from "../composables/use-fit-scale.js";
import type { FontStep } from "../composables/use-preferences.js";
import { SHELL_HEIGHT } from "./shell-view.js";
import "./tokens.css";

/*
 * The product screen: designed at 1280×720 and scaled down to the window's width (mock
 * .stage-wrap / .stage-fit / .screen). The frame's colour is the mode; the header goes in the
 * `header` slot and the panes and overlays in the default slot.
 */
const props = defineProps<{
  mode: ShellMode;
  fontStep: FontStep;
}>();

const wrap = ref<HTMLElement | null>(null);
const scale = useFitScale(wrap);

const wrapStyle = computed(() => ({ height: `${String(SHELL_HEIGHT * scale.value)}px` }));
const fitStyle = computed(() => ({ transform: `scale(${String(scale.value)})` }));
// 標準 has no attribute, as in the mock: --fs-scale falls back to 1.
const dataFs = computed(() => (props.fontStep === 1 ? undefined : String(props.fontStep)));
</script>

<template>
  <div ref="wrap" class="stage-wrap" :style="wrapStyle">
    <div class="stage-fit" :style="fitStyle">
      <div class="screen" :data-mode="mode" :data-fs="dataFs">
        <slot name="header" />
        <slot />
      </div>
    </div>
  </div>
</template>

<style>
/* Not scoped: the base rules reach every element on the screen, including slot content. */
.stage-wrap {
  position: relative;
  width: 100%;
}
.stage-fit {
  transform-origin: top left;
}
.screen {
  width: 1280px;
  height: 720px;
  position: relative;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: 16px;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  transition:
    background-color 0.78s ease,
    color 0.78s ease;
}
.screen *,
.screen *::before,
.screen *::after {
  box-sizing: border-box;
}
.screen button {
  font-family: inherit;
  cursor: pointer;
}
/* The screen's buttons (mock .btn). Disabled ones must look it: a button that looks pressable
   while the API is being checked gets pressed again and again, and reads as broken. */
.screen .btn {
  background: var(--accent);
  color: #fff;
  border: 1px solid var(--accent);
  padding: 11px 26px;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.screen .btn:hover {
  filter: brightness(1.12);
}
.screen .btn:disabled,
.screen .btn:disabled:hover {
  opacity: 0.45;
  cursor: default;
  filter: none;
}
.screen .btn.ghost {
  background: transparent;
  color: var(--fg);
  border-color: var(--rule);
  font-weight: 500;
}
.screen .btn.ghost:hover {
  background: var(--surface-2);
  filter: none;
}
.screen .row-end {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  align-items: center;
}
/* A pane's heading (mock .pane-hd): the inbox's and the shared folder's. */
.screen .pane-hd {
  flex: 0 0 auto;
  padding: 11px 14px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--fg-note);
  border-bottom: 1px solid var(--rule);
  display: flex;
  align-items: center;
  gap: 8px;
  transition:
    color 0.78s ease,
    border-color 0.78s ease;
}
/* Overlays cover the whole screen, header included (mock .veil). */
.screen .veil {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
}
.screen button:focus-visible,
.screen input:focus-visible,
.screen textarea:focus-visible,
.screen [tabindex]:focus-visible {
  outline: 2px solid #7fb2ff;
  outline-offset: 2px;
}
</style>
