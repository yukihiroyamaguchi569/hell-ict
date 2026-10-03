<script setup lang="ts">
import { prologueInboxText as text } from "@hell-ict/content";
import type { InboxMailId } from "@hell-ict/domain";

import MailReader from "../../inbox/MailReader.vue";
import { PROLOGUE_MAILS } from "./prologue-view.js";
import type { Prologue } from "./use-prologue.js";

/*
 * The Prologue's centre pane (mock inboxCenter): the note while no mail is open, else the mail
 * with the same reply box as Stage 1's first round. The mission bar above is the frame's.
 */
const props = defineProps<{
  prologue: Prologue;
}>();

const onInput = (id: InboxMailId, event: Event): void => {
  if (event.target instanceof HTMLTextAreaElement) props.prologue.setDraft(id, event.target.value);
};
</script>

<template>
  <div v-if="prologue.openMail.value === null" class="work">
    <p class="note" data-testid="prologue-note">{{ text.note[0] }}<br />{{ text.note[1] }}</p>
  </div>
  <div v-else class="work open">
    <MailReader class="mail" :mail="PROLOGUE_MAILS[prologue.openMail.value]" />
    <div class="box">
      <div class="hd">{{ text.replyHeading }}</div>
      <textarea
        class="submit-area"
        :aria-label="text.replyHeading"
        :placeholder="text.placeholder"
        :value="prologue.draft(prologue.openMail.value)"
        @input="onInput(prologue.openMail.value, $event)"
      ></textarea>
    </div>
    <div class="row-end">
      <button
        type="button"
        class="btn"
        :disabled="prologue.busy(prologue.openMail.value)"
        @click="prologue.reply(prologue.openMail.value)"
      >
        {{ prologue.emptyShown.value ? text.empty : text.send }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.work {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 28px 110px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.work.open {
  padding: 4px 24px 14px;
  gap: 8px;
  overflow: hidden;
}
.note {
  margin: 0;
  font-size: 14px;
  color: var(--fg-note);
  line-height: 1.8;
  max-width: 62ch;
}
.work .mail {
  padding: 0;
  flex: 1 1 auto;
  min-height: 0;
}
.box {
  border: 1px solid var(--rule);
  background: var(--surface);
  transition:
    background-color 0.78s ease,
    border-color 0.78s ease;
}
.box > .hd {
  padding: 8px 13px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--fg-note);
  border-bottom: 1px solid var(--rule);
}
.submit-area {
  width: 100%;
  min-height: 56px;
  resize: vertical;
  display: block;
  background: transparent;
  color: var(--fg);
  border: 0;
  padding: 13px;
  font-family: var(--font-num);
  font-size: calc(14px * var(--fs-scale));
  line-height: 1.7;
}
.submit-area::placeholder {
  color: var(--fg-note);
}
.row-end {
  flex: 0 0 auto;
}
</style>
