<script setup lang="ts">
/*
 * The left pane's two tiers (mock #pane-l): the inbox on top takes the height left over, the
 * shared folder sits underneath at its own height. The inbox slot holds the stage's inbox
 * (InboxList), and stays empty for a stage without one.
 */
</script>

<template>
  <div class="inbox" data-testid="inbox">
    <slot name="inbox" />
  </div>
  <slot />
</template>

<style scoped>
.inbox {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
