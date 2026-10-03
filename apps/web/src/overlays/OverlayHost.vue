<script setup lang="ts">
import { computed } from "vue";

import { pickOverlay, type OverlayId } from "./overlay-priority.js";

/*
 * Shows one overlay at a time (overlay-priority.ts). Each overlay is a named slot; the parent
 * lists which ones it wants now and this host draws only the most important of them.
 */
const props = defineProps<{
  requested: readonly OverlayId[];
}>();

const active = computed(() => pickOverlay(props.requested));
</script>

<template>
  <slot v-if="active !== null" :name="active" />
</template>
