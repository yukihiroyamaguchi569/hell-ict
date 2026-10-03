<script setup lang="ts">
import {
  epilogueLines,
  execVoices,
  finalHandover,
  finalLabels,
  finalRelay,
} from "@hell-ict/content";
import { computed } from "vue";

import CallWindow from "../common/CallWindow.vue";
import { relayButtonText } from "./final-view.js";
import GoalConfetti from "./GoalConfetti.vue";
import { GOAL_STOP, GOAL_STOPS, stopMark } from "./goal-view.js";
import type { Final } from "./use-final.js";

/*
 * Final's windows over the whole screen: the goal (mock #ov-goal, its confetti and the row of
 * stops with the team's marker on Final), the director's epilogue (#ov-epilogue), the relay of
 * three voices (#ov-f-relay) and the certificate (#ov-f-handover). The team's name and line are
 * text, never markup.
 */
const props = defineProps<{ final: Final }>();
const { phase, confetti, goalTitle, goalMark, address, quote } = props.final;
const mark = stopMark(GOAL_STOP);

const epilogueCall = { ...execVoices.incho, tb: finalLabels.epilogueTitle };
const relayStep = computed(() => (phase.value.kind === "relay" ? phase.value.step : 0));
const relayVoice = computed(() => finalRelay[relayStep.value] ?? finalRelay[0]);
const relayCall = computed(() => ({
  tb: `📞 ${relayVoice.value.tb}`,
  img: relayVoice.value.img,
  role: relayVoice.value.name,
}));

/** A click anywhere but a button hurries to the next voice (mock fAdvanceRelay). */
const onRelayClick = (event: MouseEvent): void => {
  if (event.target instanceof Element && event.target.closest("button") !== null) return;
  props.final.pressRelayBackdrop();
};
</script>

<template>
  <div v-if="phase.kind === 'goal'" class="veil goal" data-testid="final-goal">
    <div class="t">{{ goalTitle }}</div>
    <button type="button" class="btn" @click="final.pressGoalNext()">
      {{ finalLabels.goalNext }}
    </button>
    <div class="goal-track">
      <div class="stops">
        <span v-for="stop in GOAL_STOPS" :key="stop">{{ stop }}</span>
      </div>
      <div class="marks">
        <div
          class="mark-t"
          :class="mark.align"
          :style="{ left: `${mark.leftPct}%` }"
          data-testid="final-goal-mark"
        >
          ◆<span class="nm">{{ goalMark }}</span>
        </div>
      </div>
    </div>
    <GoalConfetti v-if="confetti" />
  </div>
  <CallWindow
    v-else-if="phase.kind === 'epilogue'"
    testid="final-epilogue"
    :call="epilogueCall"
    :lines="epilogueLines"
    :close-label="finalLabels.epilogueNext"
    @close="final.pressEpilogueNext()"
  />
  <CallWindow
    v-else-if="phase.kind === 'relay'"
    testid="final-relay"
    :call="relayCall"
    :lines="relayVoice.lines"
    :close-label="relayButtonText(relayStep)"
    @click="onRelayClick"
    @close="final.pressRelayNext()"
  />
  <div v-else-if="phase.kind === 'handover'" class="veil handover" data-testid="final-handover">
    <div class="hdoc-wrap">
      <div class="hdoc-frame">
        <span class="hcorn tl" aria-hidden="true"></span>
        <span class="hcorn tr" aria-hidden="true"></span>
        <span class="hcorn bl" aria-hidden="true"></span>
        <span class="hcorn br" aria-hidden="true"></span>
        <div class="hdoc">
          <div class="hdoc-title">{{ finalHandover.title }}</div>
          <div class="hdoc-orn" aria-hidden="true"><span></span><b>◆</b><span></span></div>
          <div class="hdoc-to" data-testid="final-address">{{ address }}</div>
          <div class="rule"></div>
          <p v-for="(text, i) in finalHandover.body" :key="i">{{ text }}</p>
          <div class="hdoc-quote" data-testid="final-quote">{{ quote }}</div>
          <div class="hdoc-sign">
            <div class="sign-date">{{ finalHandover.signDate }}</div>
            <div class="sign-org">{{ finalHandover.signOrg }}</div>
          </div>
          <div class="hdoc-seal" aria-hidden="true">
            <svg viewBox="0 0 100 100">
              <circle class="ring-out" cx="50" cy="50" r="46"></circle>
              <circle class="ring-in" cx="50" cy="50" r="39"></circle>
              <text class="seal-l1" x="50" y="42">{{ finalHandover.seal[0] }}</text>
              <text class="seal-l2" x="50" y="60">{{ finalHandover.seal[1] }}</text>
              <text class="seal-sub" x="50" y="78">{{ finalHandover.seal[2] }}</text>
            </svg>
          </div>
        </div>
      </div>
      <div class="hdoc-narration">{{ finalHandover.narration }}</div>
      <button type="button" class="hdoc-restart" @click="final.restart()">
        {{ finalHandover.restart }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The race's end (mock .goal): a bright festive backing of its own, whatever the mode. */
.goal {
  background: linear-gradient(160deg, #fffaf3 0%, #fdf0dc 55%, #fbe4c4 100%);
  flex-direction: column;
  gap: 22px;
}
.goal .t {
  font-size: 92px;
  font-weight: 800;
  letter-spacing: 0.05em;
  max-width: 92%;
  text-align: center;
  overflow-wrap: anywhere;
  background: linear-gradient(135deg, #b8631f 0%, #d9a441 45%, #c97b84 100%);
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 3px 0 rgba(255, 255, 255, 0.7))
    drop-shadow(0 10px 22px rgba(184, 99, 31, 0.35));
  animation: goalTitlePop 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes goalTitlePop {
  0% {
    transform: scale(0.4) rotate(-3deg);
    opacity: 0;
  }
  50% {
    transform: scale(1.18) rotate(2deg);
    opacity: 1;
  }
  75% {
    transform: scale(0.96) rotate(-1deg);
  }
  100% {
    transform: scale(1) rotate(0deg);
  }
}
.goal .btn {
  background: #b8631f;
  border-color: #b8631f;
  color: #fff;
}
/* The row of stops under the button (mock .goal-track), in fixed colours on the bright backing. */
.goal-track {
  width: min(84%, 900px);
}
.goal-track .stops {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-num);
  font-size: 13px;
  color: #a3906f;
  letter-spacing: 0.04em;
  margin-bottom: 22px;
}
.goal-track .marks {
  position: relative;
  height: 22px;
}
.goal-track .mark-t {
  position: absolute;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 700;
  color: #b8631f;
}
/* A marker on either end is pulled inwards so the team's name stays on screen (mock placeMark). */
.goal-track .mark-t.start {
  transform: translateX(0);
}
.goal-track .mark-t.center {
  transform: translateX(-50%);
}
.goal-track .mark-t.end {
  transform: translateX(-100%);
}
.goal-track .mark-t .nm {
  font-family: var(--font-ui);
  font-size: 12px;
}
/* The certificate (mock .handover / .hdoc): a framed hospital document in fixed colours. */
.handover {
  background: rgba(8, 9, 10, 0.78);
  padding: 12px;
}
.hdoc-wrap {
  width: 100%;
  max-width: 640px;
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.hdoc-frame {
  position: relative;
  width: 100%;
  padding: 16px;
  border: 1px solid #b8a888;
  background: linear-gradient(160deg, #fffdf7 0%, #f2e9d4 100%);
  box-shadow:
    0 14px 44px rgba(0, 0, 0, 0.4),
    0 2px 0 rgba(255, 255, 255, 0.5) inset;
  animation: hdocFrameIn 0.7s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes hdocFrameIn {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.hcorn {
  position: absolute;
  width: 22px;
  height: 22px;
  border: 0 solid #9c8552;
}
.hcorn.tl {
  top: 8px;
  left: 8px;
  border-top-width: 2px;
  border-left-width: 2px;
}
.hcorn.tr {
  top: 8px;
  right: 8px;
  border-top-width: 2px;
  border-right-width: 2px;
}
.hcorn.bl {
  bottom: 8px;
  left: 8px;
  border-bottom-width: 2px;
  border-left-width: 2px;
}
.hcorn.br {
  bottom: 8px;
  right: 8px;
  border-bottom-width: 2px;
  border-right-width: 2px;
}
.hdoc {
  position: relative;
  width: 100%;
  color: #16181a;
  border: 5px double #9c8552;
  background:
    repeating-linear-gradient(135deg, rgba(120, 100, 60, 0.035) 0 2px, transparent 2px 7px),
    linear-gradient(165deg, #fffefb 0%, #f8f2e3 100%);
  padding: 18px 36px 26px;
}
.hdoc-title {
  font-size: 22px;
  font-weight: 700;
  text-align: center;
  letter-spacing: 0.4em;
  text-indent: 0.4em;
  color: #2c2015;
}
.hdoc-orn {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 9px 0 15px;
}
.hdoc-orn span {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, #b39b6a 50%, transparent);
}
.hdoc-orn b {
  color: #ab8f57;
  font-size: 12px;
  font-weight: 400;
}
.hdoc-to {
  font-family: var(--font-legacy);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #2c2015;
  overflow-wrap: anywhere;
}
.hdoc .rule {
  border-top: 1px solid #c9b98f;
  margin: 14px 0 0;
}
.hdoc p {
  font-family: var(--font-legacy);
  font-size: 14px;
  line-height: 1.9;
  color: #333;
  margin: 14px 0 0;
}
.hdoc-quote {
  position: relative;
  margin: 20px auto 0;
  max-width: 44ch;
  padding: 16px 34px;
  border: 1.5px solid #c2a765;
  background: linear-gradient(180deg, #fffef8 0%, #faf1da 100%);
  box-shadow: inset 0 0 0 4px #fffef8;
  font-family: var(--font-legacy);
  font-size: 21px;
  font-weight: 700;
  line-height: 1.75;
  text-align: center;
  color: #241c10;
  overflow-wrap: anywhere;
  animation: hdocQuoteIn 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.35s both;
}
@keyframes hdocQuoteIn {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.hdoc-quote::before,
.hdoc-quote::after {
  position: absolute;
  font-family: Georgia, "Hiragino Mincho ProN", serif;
  font-size: 44px;
  line-height: 1;
  color: rgba(171, 143, 87, 0.5);
}
.hdoc-quote::before {
  content: "“";
  top: 4px;
  left: 12px;
}
.hdoc-quote::after {
  content: "”";
  bottom: -10px;
  right: 12px;
}
.hdoc-sign {
  margin: 22px 152px 0 0;
  text-align: right;
  font-family: var(--font-legacy);
  font-size: 14px;
  line-height: 2;
  color: #2c2015;
  animation: hdocFadeIn 0.6s ease-out 0.7s both;
}
.sign-date {
  font-size: 13px;
  color: #4a524c;
}
.sign-org {
  font-weight: 700;
  letter-spacing: 0.06em;
}
/* A seal of the fictional hospital, pressed slightly askew (not a real organisation's). */
.hdoc-seal {
  position: absolute;
  right: 30px;
  bottom: 8px;
  width: 84px;
  height: 84px;
  opacity: 0.85;
  mix-blend-mode: multiply;
  transform: rotate(-9deg);
  pointer-events: none;
  animation: hdocSealIn 0.5s ease-out 0.8s both;
}
@keyframes hdocSealIn {
  0% {
    opacity: 0;
    transform: rotate(-9deg) scale(1.7);
  }
  65% {
    opacity: 0.9;
    transform: rotate(-9deg) scale(0.93);
  }
  100% {
    opacity: 0.85;
    transform: rotate(-9deg) scale(1);
  }
}
.hdoc-seal svg {
  width: 100%;
  height: 100%;
}
.hdoc-seal circle {
  fill: none;
  stroke: #b3231f;
}
.hdoc-seal .ring-out {
  stroke-width: 2.6;
}
.hdoc-seal .ring-in {
  stroke-width: 1.4;
}
.hdoc-seal text {
  fill: #b3231f;
  font-family: var(--font-legacy);
  font-weight: 700;
  text-anchor: middle;
  letter-spacing: 0.02em;
  font-size: 15px;
}
.hdoc-seal .seal-sub {
  font-size: 9px;
  letter-spacing: 0.05em;
}
.hdoc-narration {
  font-size: 15px;
  color: #e6e9ec;
  letter-spacing: 0.06em;
  text-align: center;
  animation: hdocFadeIn 0.8s ease-out 1.05s both;
}
@keyframes hdocFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.hdoc-restart {
  background: transparent;
  color: #cdd3d8;
  border: 1px solid #6c757c;
  font-family: var(--font-ui);
  font-size: 13px;
  letter-spacing: 0.06em;
  padding: 7px 20px;
  animation: hdocFadeIn 0.8s ease-out 1.35s both;
}
.hdoc-restart:hover {
  background: rgba(255, 255, 255, 0.09);
  color: #fff;
}
</style>
