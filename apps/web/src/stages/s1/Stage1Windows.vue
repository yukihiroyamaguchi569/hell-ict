<script setup lang="ts">
import { execVoices, stage1Briefing as brief, stage1ResultText } from "@hell-ict/content";

import { portraitSrc } from "../../overlays/clear-sheets.js";
import type { Stage1 } from "./use-stage1.js";
import type { Stage1Draft } from "./use-stage1-draft.js";
import { STAGE1_BRIEF_BEATS } from "./use-stage1-screen.js";
import type { Stage1Screen } from "./use-stage1-screen.js";

/*
 * Stage 1's windows in the overlay host's stage layer (mock #ov-brief and #ov-s1res): the
 * director's briefing until [了解しました] starts the stage, a failed round's result, and the
 * clear's window before the frame's clear effect.
 * Pressing anywhere on the briefing shows the rest at once (mock s1BriefAll).
 */
defineProps<{
  stage: Stage1;
  draft: Stage1Draft;
  screen: Stage1Screen;
}>();

const director = execVoices.jimu;
/** The beats: 0 the portrait, 1〜6 the says, 7 the notice, 8 the button. */
const NOTICE_BEAT = brief.says.length + 1;
const BUTTON_BEAT = STAGE1_BRIEF_BEATS.length;
</script>

<template>
  <div
    v-if="screen.mode.value === 'waiting'"
    class="veil sysdlg briefing"
    data-testid="s1-briefing"
    @click="screen.showAllBeats()"
  >
    <div class="win" role="dialog" aria-modal="true">
      <div class="tb">
        <span class="grow">{{ brief.title }}</span
        ><span class="ctl">□ ✕</span>
      </div>
      <div class="bd">
        <div class="por beat" :class="{ on: screen.beats.value >= 1 }">
          <div class="frame"><img :src="portraitSrc(director.img)" :alt="director.role" /></div>
          <div class="cap">
            {{ director.org }}<br /><b>{{ director.role }}</b>
          </div>
        </div>
        <div class="main">
          <div
            v-for="(say, i) in brief.says"
            :key="i"
            class="say beat"
            :class="{ on: screen.beats.value >= i + 2 }"
          >
            <em v-if="'lead' in say">{{ say.lead }}</em>
            <template v-for="(line, j) in say.lines" :key="j"
              ><br v-if="j > 0" />{{ line }}</template
            >
          </div>
          <div class="notice beat" :class="{ on: screen.beats.value >= NOTICE_BEAT + 1 }">
            {{ brief.notice.join("\n") }}
          </div>
        </div>
      </div>
      <div class="ft beat" :class="{ on: screen.beats.value >= BUTTON_BEAT }">
        <button
          type="button"
          class="btn"
          :disabled="screen.beats.value < BUTTON_BEAT || screen.busy.value"
          @click.stop="screen.begin()"
        >
          {{ brief.ok }}
        </button>
      </div>
    </div>
  </div>

  <div
    v-else-if="screen.roundEnd.value !== null"
    class="veil sysdlg result"
    data-testid="s1-result"
  >
    <div class="win" role="dialog" aria-modal="true">
      <div class="tb">
        <span class="grow">{{ stage1ResultText.title }}</span
        ><span class="ctl">□ ✕</span>
      </div>
      <div class="bd">
        <div class="por">
          <div class="frame"><img :src="portraitSrc(director.img)" :alt="director.role" /></div>
          <div class="cap">
            {{ director.org }}<br /><b>{{ director.role }}</b>
          </div>
        </div>
        <div class="main">
          <div class="hd2">{{ screen.roundEnd.value.heading }}</div>
          <div class="sum">{{ screen.roundEnd.value.note }}</div>
          <div v-if="stage.state.value?.round === 1 && screen.roundEnd.value.rest" class="rest">
            {{ screen.roundEnd.value.rest }}
          </div>
          <div class="said">{{ screen.roundEnd.value.admin }}</div>
          <div v-for="(item, i) in screen.roundEnd.value.threads" :key="i" class="thread">
            <div>
              <div class="lbl">{{ item.heading }}</div>
              <div class="body">{{ item.mail }}</div>
            </div>
            <div>
              <div class="lbl">{{ stage1ResultText.yourReply }}</div>
              <div class="body">{{ item.reply }}</div>
            </div>
            <div>
              <div class="lbl">{{ item.answerFrom }}</div>
              <div class="body">{{ item.answer }}</div>
            </div>
          </div>
          <div v-if="screen.roundEnd.value.voices.length > 0" class="voices">
            <div v-for="(voice, i) in screen.roundEnd.value.voices" :key="i">{{ voice }}</div>
            <div v-if="screen.roundEnd.value.rest">{{ screen.roundEnd.value.rest }}</div>
          </div>
          <div class="row-end">
            <button
              type="button"
              class="btn"
              :disabled="screen.busy.value"
              @click="screen.nextRound()"
            >
              {{ screen.roundEnd.value.button }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- クリアの窓。事務長は出さない（直後の演出③で同じ人物が喋るため。モック 2026-09-11 決定）。 -->
  <div
    v-else-if="screen.clearWindow.value !== null"
    class="veil sysdlg result"
    data-testid="s1-clear"
  >
    <div class="win" role="dialog" aria-modal="true">
      <div class="tb">
        <span class="grow">{{ stage1ResultText.title }}</span
        ><span class="ctl">□ ✕</span>
      </div>
      <div class="bd">
        <div class="main">
          <div class="hd2">{{ screen.clearWindow.value.heading }}</div>
          <div class="sum">{{ screen.clearWindow.value.note }}</div>
          <div class="row-end">
            <button type="button" class="btn" @click="screen.closeClearWindow()">
              {{ screen.clearWindow.value.button }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 院内システムのウィンドウ（mock .sysdlg）。テーマに追従しない固定色の2003年風。 */
.sysdlg {
  padding: 40px;
}
.briefing {
  background: var(--bg);
}
.result {
  background: rgba(8, 9, 10, 0.55);
}
.win {
  width: 100%;
  max-width: 880px;
  max-height: 100%;
  background: #fbfbf8;
  color: #16181a;
  border: 1px solid #9aa0a6;
  display: flex;
  flex-direction: column;
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.16);
}
.result .win {
  max-width: 720px;
}
.tb {
  display: flex;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid #c8ccc4;
  background: #eef0ea;
  font-family: var(--font-legacy);
  font-size: 13px;
}
.tb .grow {
  flex: 1;
}
.tb .ctl {
  color: #8a908a;
  letter-spacing: 0.3em;
}
.bd {
  padding: 20px 26px 18px;
  overflow-y: auto;
  display: flex;
  gap: 24px;
  flex: 1 1 auto;
  min-height: 0;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.ft {
  border-top: 1px solid #c8ccc4;
  background: #eef0ea;
  padding: 11px 14px;
  display: flex;
  justify-content: flex-end;
}
.por {
  flex: 0 0 138px;
}
.por .frame {
  width: 138px;
  height: 150px;
  border: 1px solid #b3b8b0;
  background: #f0f1ec;
}
.por img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.por .cap {
  font-family: var(--font-legacy);
  font-size: 12px;
  line-height: 1.6;
  color: #6b736e;
  margin-top: 7px;
  text-align: center;
}
.por .cap b {
  display: block;
  font-size: 14px;
  color: #16181a;
}
.say {
  font-size: calc(17px * var(--fs-scale));
  line-height: 1.8;
}
.say em {
  font-style: normal;
  font-weight: 700;
  color: #b5651d;
}
.notice {
  white-space: pre-line;
  font-family: var(--font-legacy);
  font-size: calc(13px * var(--fs-scale));
  line-height: 1.8;
  border: 1px solid #c8ccc4;
  background: #f4f5f0;
  padding: 10px 14px;
}
/* 段落は順に出す。出るまでは押せない（透明なまま Tab で届かないように）。 */
.beat {
  opacity: 0;
  transform: translateY(4px);
  pointer-events: none;
  transition:
    opacity 0.42s ease,
    transform 0.42s ease;
}
.beat.on {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.hd2 {
  font-size: calc(17px * var(--fs-scale));
  font-weight: 700;
}
.sum {
  font-size: calc(15px * var(--fs-scale));
  line-height: 1.85;
  color: #3a413c;
}
.said {
  font-size: calc(16px * var(--fs-scale));
  line-height: 1.9;
  border-left: 3px solid #b3b8b0;
  padding-left: 13px;
}
.rest {
  font-size: calc(13px * var(--fs-scale));
  color: #6f6559;
}
.voices {
  font-size: calc(14px * var(--fs-scale));
  line-height: 1.8;
  color: #3a413c;
}
.thread {
  border: 1px solid #c8ccc4;
  background: #fff;
}
.thread > div {
  padding: 9px 13px;
}
.thread > div + div {
  border-top: 1px dashed #c8ccc4;
}
.lbl {
  font-size: calc(11px * var(--fs-scale));
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #8a908a;
  margin-bottom: 3px;
}
.body {
  font-family: var(--font-legacy);
  font-size: calc(13.5px * var(--fs-scale));
  line-height: 1.8;
  color: #3a413c;
  white-space: pre-wrap;
}
.row-end {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
