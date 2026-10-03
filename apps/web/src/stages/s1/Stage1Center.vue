<script setup lang="ts">
import { stage1ScreenText as text } from "@hell-ict/content";
import type { Stage1MailId } from "@hell-ict/domain";
import { computed } from "vue";
import type { WritableComputedRef } from "vue";

import MailReader from "../../inbox/MailReader.vue";
import type { Stage1 } from "./use-stage1.js";
import type { Stage1Draft } from "./use-stage1-draft.js";
import type { Stage1Screen } from "./use-stage1-screen.js";

/*
 * Stage 1's centre pane (mock s1Center): the open mail with its reply box, or a note with the
 * log. From R2 on, the box has the context, the key points and [AIに下書きさせる]; a draft goes
 * into the body, and the team sends it from here.
 */
const props = defineProps<{
  stage: Stage1;
  draft: Stage1Draft;
  screen: Stage1Screen;
}>();

/** A round's mail from R2 on: the body is where the AI's draft lands. */
const drafted = computed(() => props.screen.aiReady.value && props.screen.mailId.value !== null);
const bodyPlaceholder = computed(() => {
  if (props.screen.mailId.value === null) return text.memoPlaceholder;
  return drafted.value ? text.bodyPlaceholder : text.replyPlaceholder;
});

const valueOf = (event: Event): string | null =>
  event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
    ? event.target.value
    : null;

/** The draft's boxes are the composable's own refs, written through, never the prop itself. */
const write = (box: WritableComputedRef<string>, value: string): void => {
  box.value = value;
};

const onBody = (id: Stage1MailId | null, event: Event): void => {
  const value = valueOf(event);
  if (value === null) return;
  if (id === null) write(props.draft.memo, value);
  else props.draft.setBody(id, value);
};
const onContext = (event: Event): void => {
  const value = valueOf(event);
  if (value !== null) write(props.draft.context, value);
};
const onPoint = (id: Stage1MailId, event: Event): void => {
  const value = valueOf(event);
  if (value !== null) props.draft.setPoint(id, value);
};
</script>

<template>
  <div v-if="screen.mail.value !== null" class="work open" data-testid="s1-center">
    <MailReader class="mail" :mail="screen.mail.value" />
    <template v-if="screen.mailId.value !== null && screen.aiReady.value">
      <div class="box" :class="{ hi: stage.state.value?.round === 3 }">
        <div class="hd">{{ text.context }}</div>
        <textarea
          class="area ctx"
          :aria-label="text.context"
          :placeholder="
            stage.state.value?.round === 3 ? text.contextPlaceholderRound3 : text.contextPlaceholder
          "
          :value="draft.context.value"
          @input="onContext"
        ></textarea>
      </div>
      <div class="box point">
        <span class="hd">{{ text.point }}</span>
        <input
          type="text"
          class="area"
          :aria-label="text.point"
          :placeholder="text.pointPlaceholder"
          :value="draft.point(screen.mailId.value)"
          @input="onPoint(screen.mailId.value, $event)"
        />
        <button
          type="button"
          class="btn ghost"
          :disabled="draft.busy(screen.mailId.value)"
          @click="draft.draft(screen.mailId.value)"
        >
          {{ draft.label(screen.mailId.value) }}
        </button>
      </div>
    </template>
    <div class="box grow">
      <div class="hd">{{ drafted ? text.body : text.reply }}</div>
      <textarea
        class="area body"
        :aria-label="text.reply"
        :placeholder="bodyPlaceholder"
        :value="screen.mailId.value === null ? draft.memo.value : draft.body(screen.mailId.value)"
        @input="onBody(screen.mailId.value, $event)"
      ></textarea>
    </div>
    <div class="row-end">
      <button
        v-if="screen.mode.value === 'memo'"
        type="button"
        class="btn ghost"
        @click="screen.copyMemo()"
      >
        {{ screen.copyLabel.value }}
      </button>
      <button type="button" class="btn" @click="screen.send()">{{ screen.sendLabel.value }}</button>
    </div>
  </div>
  <div v-else-if="screen.mode.value !== 'waiting'" class="work" data-testid="s1-center">
    <div v-if="screen.mode.value === 'round-end' && screen.roundEnd.value !== null" class="box">
      <div class="hd">{{ screen.roundEnd.value.heading }}</div>
      <p class="note pad">{{ screen.roundEnd.value.note }}</p>
    </div>
    <div v-else-if="stage.state.value?.status.phase === 'cleared'" class="box">
      <div class="hd">{{ text.cleared }}</div>
      <p class="note pad">{{ text.clearedNote[stage.state.value.status.result] }}</p>
    </div>
    <p v-else class="note">{{ text.note[0] }}<br />{{ text.note[1] }}</p>
    <div v-if="screen.log.value.length > 0" class="log" data-testid="s1-log">
      <div v-for="(line, i) in screen.log.value" :key="i">{{ line }}</div>
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
.work .mail {
  padding: 0;
  flex: 0 1 auto;
  min-height: 0;
}
.note {
  margin: 0;
  font-size: 14px;
  color: var(--fg-note);
  line-height: 1.8;
  max-width: 62ch;
}
.note.pad {
  padding: 16px 18px;
}
.box {
  border: 1px solid var(--rule);
  background: var(--surface);
}
.box.hi {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.box.grow {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
}
.box .hd {
  padding: 8px 13px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--fg-note);
  border-bottom: 1px solid var(--rule);
}
.box.point {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 13px;
}
.box.point .hd {
  padding: 0;
  border: 0;
  white-space: nowrap;
}
.box.point .btn {
  padding: 5px 13px;
  font-size: 13px;
  white-space: nowrap;
}
.area {
  width: 100%;
  display: block;
  background: transparent;
  color: var(--fg);
  border: 0;
  padding: 13px;
  font-family: var(--font-num);
  font-size: calc(14px * var(--fs-scale));
  line-height: 1.7;
  resize: none;
}
.box.point .area {
  flex: 1 1 auto;
  width: auto;
  padding: 6px 8px;
}
.area.ctx {
  min-height: 36px;
}
.area.body {
  flex: 1 1 auto;
  min-height: 56px;
}
.area::placeholder {
  color: var(--fg-note);
}
/* 苅部さんのバー（KarubePhone、画面右端から400px）と同じ行に並ぶ。バーはボタンより左にある。 */
.row-end {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.log {
  font-size: 13px;
  color: var(--fg-note);
  line-height: 2;
}
</style>
