<script setup lang="ts">
/*
 * The centre pane of a stage that is not built yet (its module in stages/<id>/index.ts is
 * `null`). Only the words: no button, so nothing is sent for the stage.
 */
</script>

<template>
  <div class="coming-soon" data-testid="coming-soon">
    <p>この先は準備中です</p>
  </div>
</template>

<style scoped>
.coming-soon {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 60px;
  color: var(--fg-muted);
  font-size: calc(18px * var(--fs-scale));
}
</style>
