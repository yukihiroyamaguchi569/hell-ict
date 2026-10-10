<script setup lang="ts">
import { handoverHeading } from "@hell-ict/content";

import type { ClearStep } from "../composables/use-clear-sequence.js";
import type { ClearSheets } from "./clear-sheets.js";
import FullscreenScene from "./FullscreenScene.vue";

/*
 * The sheets of a stage's clear (mock #ov-unlock, #ov-field, #ov-exec, #ov-handover). ② and ③
 * are a picture over the whole screen with subtitles on a gradient band (FullscreenScene,
 * Issue #371). The order,
 * the timer of ① and the single `advance` live in use-clear-sequence; this only draws the sheet
 * of `step`. ② ③ ④ move on from the button or a click anywhere on the veil (one handler on the
 * veil: the button's click bubbles up to it, so it never fires twice). ① takes no click.
 */
defineProps<{
  step: ClearStep;
  sheets: ClearSheets;
  /** `advance` is on its way: the last button waits. */
  sending: boolean;
}>();

const emit = defineEmits<{
  next: [];
}>();

const onVeil = (): void => {
  emit("next");
};
</script>

<template>
  <div v-if="step === 'unlock'" class="veil unlock" data-testid="clear-unlock">
    <div class="panel">
      <div class="bar"></div>
      <div class="t">{{ sheets.title }}</div>
      <div v-if="sheets.sub !== ''" class="s">{{ sheets.sub }}</div>
    </div>
  </div>

  <FullscreenScene
    v-else-if="step === 'field' || step === 'exec'"
    :testid="step === 'field' ? 'clear-field' : 'clear-exec'"
    :art="sheets[step].art"
    :name="sheets[step].name"
    :lines="sheets[step].lines"
    button-label="次へ"
    :disabled="sending"
    advance-on-veil
    @next="onVeil"
  />

  <div v-else class="veil opnote" data-testid="clear-handover" @click="onVeil">
    <div class="card" role="dialog" aria-modal="true">
      <div class="mark" aria-hidden="true">🔁</div>
      <div class="hd">{{ handoverHeading }}</div>
      <div>
        <div v-for="(line, i) in sheets.handover ?? []" :key="i" class="ln">{{ line }}</div>
      </div>
      <button type="button" class="btn" :disabled="sending">次へ</button>
    </div>
  </div>
</template>

<style scoped>
/* ① クリアの告知（mock .unlock）。文字の背後に半透明のパネルを敷き、下の画面と重ねない。 */
.unlock {
  background: rgba(8, 9, 10, 0.72);
}
.unlock .panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 44px 72px 40px;
  border-radius: 14px;
  background: rgba(12, 14, 16, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}
/* 帯は幅を 600px に固定し、伸びる見た目は scaleX で作る（width を動かすとパネルごと伸び縮みする）。 */
.unlock .bar {
  height: 5px;
  width: 600px;
  background: var(--ok);
  transform: scaleX(0);
  transform-origin: left;
  animation: sweep 0.5s ease-out forwards;
}
@keyframes sweep {
  to {
    transform: scaleX(1);
  }
}
/* 文字サイズの段階は掛けない。特大で伸ばすと 600px の帯やパネルから溢れる。 */
.unlock .t {
  font-size: 42px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.05em;
}
.unlock .s {
  font-size: 20px;
  color: #b9c2c9;
}

/* ④ 操作担当の交代（mock .opnote）。病院の UI に見せない：タイトルバーなし、角丸、淡い紙色、
   テーマに追従しない落ち着いた緑。進行の案内であって、罰でも失敗でもない。 */
.opnote {
  background: rgba(8, 9, 10, 0.62);
  padding: 40px;
}
.opnote .card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  width: 100%;
  max-width: 660px;
  max-height: 100%;
  overflow-y: auto;
  padding: 38px 46px 34px;
  border-radius: 18px;
  text-align: center;
  background: linear-gradient(180deg, #f5f8f6 0%, #e9efeb 100%);
  color: #1d2a27;
  box-shadow: 0 20px 54px rgba(0, 0, 0, 0.5);
}
.opnote .mark {
  flex: 0 0 auto;
  width: calc(64px * var(--fs-scale));
  height: calc(64px * var(--fs-scale));
  border-radius: 50%;
  background: #dce7e2;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: calc(30px * var(--fs-scale));
  line-height: 1;
}
.opnote .hd {
  font-size: calc(26px * var(--fs-scale));
  font-weight: 700;
  line-height: 1.5;
  letter-spacing: 0.02em;
}
.opnote .ln {
  font-size: calc(16px * var(--fs-scale));
  line-height: 2;
  color: #47534f;
  text-wrap: pretty;
}
.opnote .ln + .ln {
  margin-top: 8px;
}
/* ボタンだけは .btn の var(--accent) を上書きする（crisis では赤になるため）。 */
.opnote .btn {
  margin-top: 6px;
  background: #3f7d78;
  border-color: #3f7d78;
  border-radius: 999px;
  padding: 12px 38px;
  font-size: calc(16px * var(--fs-scale));
}
</style>
