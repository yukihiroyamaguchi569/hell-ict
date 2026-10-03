<script setup lang="ts">
import { aiGreetingText, chatPaneText, chatPrepareFailed } from "@hell-ict/content";
import { computed, nextTick, ref, watch } from "vue";

import { useAppContext } from "../app-context.js";
import { isImeComposing } from "../ime-composing.js";
import ChatBubble from "./ChatBubble.vue";
import { showsPrepareFailure } from "./chat-view.js";
import { withScriptedTurns } from "./pane-items.js";
import {
  paneConversation,
  useScriptedChat,
  type ChatSubmit,
  type ScriptedChat,
} from "./use-scripted-chat.js";

/*
 * The AI chat on the right (mock #pane-r.ai): the current stage's conversation and the input.
 * What to show and whether to send comes from useStageChat; this only draws it.
 */
const props = defineProps<{
  /**
   * Replaces sending to the AI (Stage 2 answers on the screen: V4 hands it
   * in). Without it, a stage that is not live keeps the input closed.
   */
  onSubmit?: ChatSubmit;
  /**
   * The stage's own conversation (Stage 6: V8 hands in `StageInstance.chat`). Drawn and sent to
   * instead of `onSubmit`'s: the stage keeps its turns (and draws them again after a reload).
   */
  chat?: ScriptedChat | undefined;
}>();

const { stageChat, scheduler } = useAppContext();
const { draft, mode, sending, preparing } = stageChat;
const scripted = useScriptedChat(() => props.onSubmit, scheduler);
const conversation = computed(() => paneConversation(props.chat, props.onSubmit, scripted));
const items = computed(() =>
  withScriptedTurns(stageChat.items.value, conversation.value?.turns.value ?? []),
);

const open = computed(
  () => !sending.value && (conversation.value !== null || mode.value === "live"),
);

const submit = (): void => {
  if (!open.value) return;
  const own = conversation.value;
  if (own === null) {
    void stageChat.send();
    return;
  }
  const text = draft.value.trim();
  if (text === "") return;
  draft.value = "";
  own.send(text);
};

/** Enter sends, Shift+Enter breaks the line; the Enter that confirms a conversion does not send. */
const onKeydown = (event: KeyboardEvent): void => {
  if (event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
  event.preventDefault();
  submit();
};

const log = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);

/**
 * The newest bubble stays in view (mock aiBubble). A scripted answer is shown from its top (mock
 * scrollBubbleToTop): its table is taller than the pane, and its button sits above the table.
 */
watch(items, async (next) => {
  await nextTick();
  const el = log.value;
  if (el === null) return;
  const newest = el.lastElementChild;
  if (next.at(-1)?.kind === "scripted" && newest instanceof HTMLElement) {
    el.scrollTop += newest.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
    return;
  }
  el.scrollTop = el.scrollHeight;
});

/**
 * The input grows with its text up to 40% of the pane (mock autoGrowAiInput) and goes back to
 * one line when emptied. The CSS min-height is the one line at the current text size.
 */
const grow = (): void => {
  const textarea = input.value;
  if (textarea === null) return;
  textarea.style.height = "";
  if (textarea.value === "") return;
  const base = parseFloat(getComputedStyle(textarea).minHeight) || 0;
  const pane = textarea.closest(".ai")?.clientHeight ?? 0;
  const cap = Math.max(base, Math.round(pane * 0.4));
  textarea.style.maxHeight = `${String(cap)}px`;
  textarea.style.height = `${String(Math.min(cap, Math.max(base, textarea.scrollHeight)))}px`;
};
watch(draft, async () => {
  await nextTick();
  grow();
});
</script>

<template>
  <div class="ai" data-testid="chat-pane">
    <div class="ai-hd">
      <span>{{ chatPaneText.title }}</span
      ><span class="sub">{{ chatPaneText.scope }}</span>
    </div>
    <div ref="log" class="log" data-testid="chat-log">
      <div
        v-if="showsPrepareFailure(mode, conversation !== null)"
        class="failed"
        data-testid="chat-failed"
      >
        <p>{{ chatPrepareFailed.text }}</p>
        <button type="button" :disabled="preparing" @click="stageChat.retryPrepare">
          {{ chatPrepareFailed.retry }}
        </button>
      </div>
      <template v-else>
        <template v-for="item in items" :key="item.key">
          <ChatBubble
            v-if="item.kind === 'greeting'"
            who="assistant"
            :text="aiGreetingText"
            greeting
          />
          <ChatBubble v-else-if="item.kind === 'message'" :who="item.role" :text="item.text" />
          <ChatBubble v-else-if="item.kind === 'notice'" who="system" :text="item.text" />
          <ChatBubble
            v-else-if="item.kind === 'scripted'"
            who="assistant"
            :text="item.text"
            :image="item.image"
            scripted
          >
            <template v-if="item.action !== null" #action>
              <button type="button" class="to-grid" @click="item.action.run()">
                {{ item.action.label }}
              </button>
            </template>
          </ChatBubble>
          <ChatBubble
            v-else-if="item.kind === 'waiting'"
            who="assistant"
            :text="item.text"
            :progress-ms="item.progressMs"
          />
          <ChatBubble v-else who="assistant" :text="chatPaneText.typing" />
        </template>
      </template>
    </div>
    <div class="compose">
      <textarea
        ref="input"
        v-model="draft"
        :disabled="!open"
        :aria-label="chatPaneText.inputLabel"
        @keydown="onKeydown"
      ></textarea>
      <button type="button" :disabled="!open" @click="submit">{{ chatPaneText.send }}</button>
    </div>
  </div>
</template>

<style scoped>
/* 暗い病院の中で、ここだけが白い。 */
.ai {
  flex: 1;
  background: var(--ai-surface);
  color: var(--ai-fg);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/* 右ペインの役割を上端に固定で置く（Issue #146）。高さは文字サイズの段階で変えない。 */
.ai-hd {
  flex: 0 0 auto;
  height: 38px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--ai-rule);
  background: var(--ai-surface-2);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--ai-fg);
}
.ai-hd .sub {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--ai-muted);
}
.log {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.failed {
  font-size: calc(15px * var(--fs-scale));
  line-height: 1.7;
}
.failed p {
  margin: 0 0 9px;
}
.failed button,
.compose button {
  border: 0;
  background: var(--ai-fg);
  color: #fff;
  padding: 12px 17px;
  font-size: 15px;
  font-weight: 700;
}
/* 返答の表を提出の表へ流し込むボタン。表が20〜30行あるので、表の上（導入文の直後）に置く。 */
.to-grid {
  display: block;
  margin: 9px 0 0;
  border: 0;
  background: var(--ai-fg);
  color: #fff;
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 700;
  padding: 9px 15px;
  white-space: nowrap;
}
.compose {
  border-top: 1px solid var(--ai-rule);
  padding: 11px 12px;
  display: flex;
  gap: 9px;
  align-items: flex-end;
}
.compose textarea {
  flex: 1;
  resize: vertical;
  height: calc(44px * var(--fs-scale));
  min-height: calc(44px * var(--fs-scale));
  /* grow() が実測（ペイン高の40%）で上書きする。ここは描画前の保険。 */
  max-height: 84px;
  padding: 11px 12px;
  border: 1px solid var(--ai-rule);
  background: #fff;
  color: var(--ai-fg);
  font-family: var(--font-ui);
  font-size: calc(15px * var(--fs-scale));
  line-height: 1.5;
  overflow-y: auto;
}
</style>
