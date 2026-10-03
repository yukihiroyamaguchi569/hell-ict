<script setup lang="ts">
/*
 * The first screen after entering (mock renderWelcome). No instructions at all: the first
 * contact with the AI is kept for Stage 1. The fever in the header is already there, lost among
 * the ordinary figures.
 */
defineEmits<{
  openInbox: [];
}>();
</script>

<template>
  <div class="welcome">
    <div class="inner">
      <h2>聖クロノス総合病院 感染制御チーム（ICT）へようこそ</h2>
      <div class="say">
        本日より支援に入っていただく皆さんです。まずは落ち着いて、届いているメールに目を通して返信してください。何も起きていません。いい一日になりますように。
      </div>
      <div class="row-end">
        <button type="button" class="btn" @click="$emit('openInbox')">メールを開く</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  padding: 40px 60px;
  overflow-y: auto;
}
.inner {
  max-width: 780px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
h2 {
  font-size: 25px;
  font-weight: 700;
  margin: 0;
  text-wrap: balance;
}
.say {
  font-size: 18px;
  line-height: 1.85;
  max-width: 58ch;
}
</style>
