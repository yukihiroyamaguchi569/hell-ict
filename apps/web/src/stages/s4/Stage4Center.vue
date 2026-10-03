<script setup lang="ts">
import { stage4Brief, stage4Labels, stage4QuestionLines } from "@hell-ict/content";
import { CHAT_MESSAGE_MAX_CHARS } from "@hell-ict/domain";
import { nextTick, useTemplateRef, watch } from "vue";

import VerdictBox from "../../verdict/VerdictBox.vue";
import type { Stage4 } from "./use-stage4.js";

/*
 * Stage 4's centre pane (mock renderStage4 and s4ShowDirectorTalk): the summary for the director
 * and, once it went through, the talk with the director under it. The summary stays on screen,
 * read-only, so the team can look back at it while answering.
 */
const props = defineProps<{ s4: Stage4 }>();
// The stage's refs, bound once per stay: top-level refs unwrap in the template and take v-model.
const {
  summary,
  summaryAccepted,
  summarySending,
  summaryWarn,
  summaryVerdict,
  submitSummary,
  talkShown,
  action,
  actionSending,
  actionWarn,
  actionVerdict,
  cleared,
  submitAction,
} = props.s4;

const work = useTemplateRef<HTMLElement>("work");
/** The talk and its verdicts come at the bottom: scroll there so they are not missed. */
const toBottom = (): void => {
  void nextTick(() => {
    work.value?.scrollTo({ top: work.value.scrollHeight, behavior: "smooth" });
  });
};
watch([talkShown, actionVerdict], toBottom);
</script>

<template>
  <div ref="work" class="work" data-testid="s4-center">
    <div class="brief">{{ stage4Brief }}</div>
    <div class="box" :class="{ warn: summaryWarn }">
      <div class="hd">{{ stage4Labels.summaryHeading }}</div>
      <textarea
        v-model="summary"
        class="submit-area"
        :aria-label="stage4Labels.summaryHeading"
        :readonly="summaryAccepted"
        :maxlength="CHAT_MESSAGE_MAX_CHARS"
      ></textarea>
    </div>
    <div class="row-end">
      <button
        type="button"
        class="btn"
        :disabled="summaryAccepted || summarySending"
        @click="submitSummary"
      >
        {{ stage4Labels.submitSummary }}
      </button>
    </div>
    <VerdictBox v-if="summaryVerdict !== null" :verdict="summaryVerdict" />

    <div v-if="talkShown" class="talk" data-testid="s4-talk">
      <div class="tb">{{ stage4Labels.talkTitle }}</div>
      <div class="bd">
        <div v-for="(line, i) in stage4QuestionLines" :key="i" class="say">{{ line }}</div>
        <template v-if="!cleared">
          <div class="box" :class="{ warn: actionWarn }">
            <textarea
              v-model="action"
              class="submit-area action"
              :aria-label="stage4Labels.actionLabel"
              :maxlength="CHAT_MESSAGE_MAX_CHARS"
            ></textarea>
          </div>
          <div class="row-end">
            <button type="button" class="btn" :disabled="actionSending" @click="submitAction">
              {{ stage4Labels.submitAction }}
            </button>
          </div>
          <VerdictBox v-if="actionVerdict !== null" :verdict="actionVerdict" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.work {
  flex: 1;
  overflow-y: auto;
  padding: 12px 28px 110px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.brief {
  font-size: calc(16px * var(--fs-scale));
  line-height: 1.7;
  max-width: 60ch;
}
.box {
  border: 1px solid var(--rule);
  background: var(--surface);
}
.box > .hd {
  padding: 8px 13px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--fg-note);
  border-bottom: 1px solid var(--rule);
}
.box:not(.warn):focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}
.box.warn {
  border-color: var(--warn);
}
.box.warn > .hd {
  color: var(--warn);
}
.submit-area {
  width: 100%;
  min-height: 160px;
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
.submit-area.action {
  min-height: 90px;
}

/* 院長の一往復（mock .s4-talk）。病院から届くものなので2003年風の固定色、テーマに追従しない。 */
.talk {
  font-family: var(--font-legacy);
  border: 1px solid var(--phs);
  background: #fff;
  color: #16181a;
}
.talk > .tb {
  background: var(--phs);
  color: #fff;
  padding: 9px 12px;
  font-size: 13px;
}
.talk > .bd {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.talk .say {
  font-size: calc(15px * var(--fs-scale));
  line-height: 1.8;
}
.talk .box {
  background: #fff;
  border-color: #cfd6d1;
}
.talk .box.warn {
  border-color: var(--warn);
}
.talk .submit-area {
  color: #16181a;
}
.talk :deep(.lead) {
  color: #4a514c;
}
</style>
