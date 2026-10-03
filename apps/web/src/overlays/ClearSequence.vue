<script setup lang="ts">
import { handoverHeading } from "@hell-ict/content";

import type { ClearStep } from "../composables/use-clear-sequence.js";
import type { ClearSheets } from "./clear-sheets.js";

/*
 * The sheets of a stage's clear (mock #ov-unlock, #ov-field, #ov-exec, #ov-handover). ② and ③
 * are a picture over the whole screen with subtitles on a gradient band (Issue #371). The order,
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

  <div
    v-else-if="step === 'field' || step === 'exec'"
    class="veil scene"
    :data-testid="step === 'field' ? 'clear-field' : 'clear-exec'"
    role="dialog"
    aria-modal="true"
    :aria-label="sheets[step].name"
    @click="onVeil"
  >
    <img
      :key="sheets[step].art.src"
      class="art"
      :src="sheets[step].art.src"
      :alt="sheets[step].name"
      :style="{ objectPosition: sheets[step].art.position }"
    />
    <div class="band">
      <div class="who">{{ sheets[step].name }}</div>
      <div class="row">
        <div class="lines">
          <p v-for="(line, i) in sheets[step].lines" :key="i" class="say">{{ line }}</p>
        </div>
        <button type="button" class="next" :disabled="sending">次へ</button>
      </div>
    </div>
  </div>

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

/* ②③ 全画面の一枚絵＋字幕（Issue #371）。字幕帯は画像に焼き込まず、ここのグラデーションで
   統一する（絵ごとに下端の暗さが違い、明るい絵でも読めるように）。テーマに追従しない固定色。 */
.scene {
  background: #000;
  cursor: pointer;
}
.scene .art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.scene .band {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 100%;
  overflow-y: auto;
  padding: 120px 72px 34px;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.88) 0%,
    rgba(0, 0, 0, 0.72) 55%,
    rgba(0, 0, 0, 0) 100%
  );
  color: #fff;
}
/* 名札：「所属 役職」。左の金の縦線で台詞と分ける。 */
.scene .who {
  display: inline-block;
  margin-bottom: 12px;
  padding: 3px 14px;
  border-left: 4px solid #e8c15a;
  background: rgba(0, 0, 0, 0.35);
  font-size: calc(20px * var(--fs-scale));
  font-weight: 700;
  letter-spacing: 0.04em;
}
.scene .row {
  display: flex;
  align-items: flex-end;
  gap: 28px;
}
.scene .lines {
  flex: 1;
  min-width: 0;
}
.scene .say {
  margin: 0;
  font-size: calc(28px * var(--fs-scale));
  line-height: 1.55;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.9);
  text-wrap: pretty;
}
.scene .say + .say {
  margin-top: 6px;
}
/* 画面のどこを押しても進む。ボタンは「押せる」ことを見せる目印で、押せば同じく進む。 */
.scene .next {
  flex: 0 0 auto;
  padding: 8px 24px;
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
.scene .next:disabled {
  opacity: 0.45;
  cursor: default;
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
