<script setup lang="ts">
import { rightPaneAttrs, type LeftPane, type RightPane } from "./shell-view.js";

/*
 * The body under the header (mock .body): inbox on the left (260px), the work in the centre,
 * the AI chat on the right (380px). The widths do not follow the text size, so the facilitator
 * can always say "the AI on the right". A collapsed right pane waits off-screen and slides in.
 */
defineProps<{
  left: LeftPane;
  right: RightPane;
}>();
</script>

<template>
  <div class="body">
    <div v-show="left !== 'hidden'" class="pane-l" data-testid="pane-left">
      <slot name="left" />
    </div>
    <div class="pane-c" data-testid="pane-center">
      <slot />
    </div>
    <div
      v-show="right !== 'hidden'"
      class="pane-r"
      :class="{ collapsed: right === 'collapsed' }"
      v-bind="rightPaneAttrs(right)"
      data-testid="pane-right"
    >
      <slot name="right" />
    </div>
  </div>
</template>

<style scoped>
/* position: relative は、苅部さんの窓（KarubePhone）の基準。モックの .phs と同じく、
   右ペインの有無にかかわらず画面の右端から 400px に置くため、中央ペインではなくここを基準にする。 */
.body {
  position: relative;
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.pane-l {
  flex: 0 0 260px;
  border-right: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  min-height: 0;
  transition: border-color 0.78s ease;
}
.pane-c {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/* min-width:0 を明示する。flex要素の既定 min-width:auto が flex-basis の 380px を上書きして
   ペインを勝手に広げないよう、幅はこの1か所で決まり切るようにしておく。 */
.pane-r {
  flex: 0 0 380px;
  min-width: 0;
  max-width: 380px;
  border-left: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  min-height: 0;
  transition:
    border-color 0.78s ease,
    margin-right 0.42s cubic-bezier(0.2, 0.72, 0.28, 1),
    opacity 0.34s ease;
}
/* 畳んだAIペインは右へ逃がしておく。出現は右から滑り込む。 */
.pane-r.collapsed {
  margin-right: -380px;
  opacity: 0;
  pointer-events: none;
}
</style>
