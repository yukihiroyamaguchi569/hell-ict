<script setup lang="ts">
import type { ViewerId } from "@hell-ict/content";

import { SHARED_FOLDER_EMPTY_TEXT, type SharedFolderItem } from "./shared-folder-view.js";

/*
 * The shared folder under the inbox (mock .docs). Quieter than the inbox on purpose: muted text,
 * no badge. Which documents lie here is shared-folder-view's call.
 */
defineProps<{
  items: readonly SharedFolderItem[];
}>();

defineEmits<{
  open: [id: ViewerId];
}>();
</script>

<template>
  <div class="docs" data-testid="shared-folder">
    <div class="pane-hd">共有フォルダ</div>
    <div v-if="items.length === 0" class="empty">{{ SHARED_FOLDER_EMPTY_TEXT }}</div>
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="docitem"
      @click="$emit('open', item.id)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<style scoped>
.docs {
  flex: 0 0 auto;
  border-top: 1px solid var(--rule);
}
.docitem {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  padding: 9px 14px;
  font-size: calc(13px * var(--fs-scale));
  color: var(--fg-muted);
  font-family: var(--font-ui);
  cursor: pointer;
}
.docitem:hover {
  background: var(--surface-2);
  color: var(--fg);
}
.empty {
  padding: 9px 14px;
  font-size: calc(13px * var(--fs-scale));
  color: var(--fg-muted);
}
</style>
