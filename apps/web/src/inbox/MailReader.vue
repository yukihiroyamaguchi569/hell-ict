<script setup lang="ts">
import type { Mail } from "@hell-ict/content";

/*
 * A mail read in the centre pane, in the hospital's 2003 format (mock mailBodyHTML). The stage
 * places it and puts whatever it needs (a reply form) in the slot underneath.
 */
defineProps<{
  mail: Mail;
}>();
</script>

<template>
  <div class="reader legacy" data-testid="mail-reader">
    <h2>件名: {{ mail.subj }}</h2>
    <div class="meta">差出人: {{ mail.from }}</div>
    <div class="rule"></div>
    <p v-for="(paragraph, index) in mail.body" :key="index">{{ paragraph }}</p>
    <template v-if="mail.attach">
      <div class="rule"></div>
      <div class="meta">📎 {{ mail.attach }}</div>
    </template>
    <slot />
  </div>
</template>

<style scoped>
.reader {
  flex: 1;
  overflow-y: auto;
  padding: 22px 28px;
}
.legacy {
  font-family: var(--font-legacy);
  font-size: calc(15px * var(--fs-scale));
  line-height: 1.9;
}
.rule {
  border-top: 1px solid var(--rule);
  margin: 12px 0;
  transition: border-color 0.78s ease;
}
.meta {
  font-size: calc(13px * var(--fs-scale));
  color: var(--fg-muted);
}
h2 {
  font-size: calc(17px * var(--fs-scale));
  font-weight: 700;
  margin: 0;
}
p {
  margin: 0 0 1.1em;
  max-width: 62ch;
}
p:last-of-type {
  margin-bottom: 0;
}
</style>
