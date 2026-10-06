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
import { CERTIFICATE_FRAME, GOAL_BACKDROP, quoteSize, relayButtonText } from "./final-view.js";
import GoalConfetti from "./GoalConfetti.vue";
import type { Final } from "./use-final.js";

/*
 * Final's windows over the whole screen: the goal (mock #ov-goal and its confetti, over a stage
 * picture), the director's epilogue (#ov-epilogue), the relay of three voices (#ov-f-relay) and
 * the certificate (#ov-f-handover, its text inside a framed picture). The team's name and line
 * are text, never markup.
 */
const props = defineProps<{ final: Final }>();
const { phase, confetti, goalName, goalTitle, address, quote } = props.final;
const quoteClass = computed(() => quoteSize(quote.value));

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
    <img class="art" :src="GOAL_BACKDROP" alt="" />
    <h2 class="t" :aria-label="goalTitle">
      <span class="nm" data-testid="final-goal-name">{{ goalName }}</span>
      <span class="word" data-testid="final-goal-word">{{ finalLabels.goal }}</span>
    </h2>
    <button type="button" class="btn" @click="final.pressGoalNext()">
      {{ finalLabels.goalNext }}
    </button>
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
        <img class="frame-art" :src="CERTIFICATE_FRAME" alt="" />
        <div class="hdoc">
          <div class="hdoc-title">{{ finalHandover.title }}</div>
          <div class="hdoc-to" data-testid="final-address">{{ address }}</div>
          <p v-for="(text, i) in finalHandover.body" :key="i">{{ text }}</p>
          <div class="hdoc-quote" :class="quoteClass" data-testid="final-quote">{{ quote }}</div>
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
/*
 * The race's end (mock .goal): a festive stage picture, whatever the mode, with the title over its
 * bright middle. The light there is near white, so the letters are gold and white with a dark
 * outline and a dark glow under them.
 */
.goal {
  background: #2a0605;
  flex-direction: column;
  gap: 34px;
}
.goal .art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
}
.goal .t {
  position: relative;
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 88%;
  font-family: var(--font-ui);
  font-weight: 900;
  line-height: 1.1;
  text-align: center;
  filter: drop-shadow(0 4px 3px rgba(40, 4, 0, 0.55)) drop-shadow(0 0 26px rgba(60, 8, 0, 0.55));
  animation: goalTitlePop 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
/* The name may be up to 12 wide letters: it wraps rather than leave the screen. */
.goal .nm {
  max-width: 100%;
  font-size: 58px;
  letter-spacing: 0.06em;
  color: #fffaf0;
  -webkit-text-stroke: 7px #4a0f06;
  paint-order: stroke fill;
  overflow-wrap: anywhere;
}
.goal .word {
  font-size: 150px;
  letter-spacing: 0.08em;
  text-indent: 0.08em;
  color: #ffe6a0;
  -webkit-text-stroke: 10px #4a0f06;
  paint-order: stroke fill;
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
  position: relative;
  padding: 12px 40px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #4a0f06;
  background: linear-gradient(180deg, #fff6d6 0%, #f3cf6b 55%, #d9a23a 100%);
  border: 2px solid #7a1c0c;
  border-radius: 999px;
  box-shadow:
    0 0 0 3px rgba(255, 244, 205, 0.85),
    0 8px 22px rgba(40, 4, 0, 0.55);
}
.goal .btn:hover {
  background: linear-gradient(180deg, #fffaf0 0%, #f8dc8a 55%, #e6b24c 100%);
}
/*
 * The certificate (mock .handover / .hdoc): the hospital's document on a gilded frame picture,
 * in fixed colours. The text stays inside the picture's plain middle, clear of the phoenixes in
 * its corners. The veil behind is near black, so the game underneath does not show through the
 * narration.
 */
.handover {
  --font-cert: "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", serif;
  background: rgba(6, 6, 8, 0.97);
  backdrop-filter: blur(8px);
  padding: 12px;
}
.hdoc-wrap {
  width: 100%;
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
/* The box keeps the picture's 1586:992, so the frame's corners land where the text expects. */
.hdoc-frame {
  position: relative;
  flex: none;
  width: 880px;
  max-width: 100%;
  aspect-ratio: 1586 / 992;
  box-shadow: 0 18px 56px rgba(0, 0, 0, 0.7);
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
.frame-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
/* The plain middle of the frame: inside the gold lines and clear of the corner ornaments. */
.hdoc {
  position: absolute;
  top: 9.5%;
  bottom: 10%;
  left: 14.5%;
  right: 14.5%;
  display: flex;
  flex-direction: column;
  color: #16181a;
}
.hdoc-title {
  font-family: var(--font-cert);
  font-size: 40px;
  font-weight: 700;
  line-height: 1.2;
  text-align: center;
  letter-spacing: 0.6em;
  text-indent: 0.6em;
  color: #2a1c0c;
  text-shadow:
    0 1px 0 rgba(255, 255, 255, 0.7),
    0 0 12px rgba(201, 158, 62, 0.45);
}
.hdoc-to {
  margin-top: 10px;
  font-family: var(--font-cert);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #2a1c0c;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(166, 128, 52, 0.55);
  overflow-wrap: anywhere;
}
.hdoc p {
  font-family: var(--font-legacy);
  font-size: 14px;
  line-height: 1.75;
  color: #2f2a22;
  margin: 8px 0 0;
  text-indent: 1em;
}
.hdoc-quote {
  position: relative;
  margin: 12px auto 0;
  max-width: 100%;
  padding: 10px 36px;
  border: 1.5px solid #c2a765;
  background: rgba(255, 252, 240, 0.72);
  box-shadow: inset 0 0 0 4px rgba(255, 252, 240, 0.9);
  font-family: var(--font-cert);
  font-weight: 700;
  text-align: center;
  color: #241c10;
  overflow-wrap: anywhere;
  animation: hdocQuoteIn 0.55s cubic-bezier(0.22, 1, 0.36, 1) 0.35s both;
}
/* Sized by quoteSize(): the longest line still fits above the signature. */
.hdoc-quote.large {
  font-size: 22px;
  line-height: 1.6;
}
.hdoc-quote.medium {
  font-size: 18px;
  line-height: 1.55;
}
.hdoc-quote.small {
  font-size: 15px;
  line-height: 1.5;
  padding: 8px 30px;
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
  font-size: 40px;
  line-height: 1;
  color: rgba(171, 143, 87, 0.5);
}
.hdoc-quote::before {
  content: "“";
  top: 2px;
  left: 10px;
}
.hdoc-quote::after {
  content: "”";
  bottom: -12px;
  right: 10px;
}
.hdoc-sign {
  margin: auto 124px 0 0;
  padding-top: 8px;
  text-align: right;
  font-family: var(--font-legacy);
  font-size: 14px;
  line-height: 1.8;
  color: #2a1c0c;
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
  bottom: -6px;
  width: 80px;
  height: 80px;
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
