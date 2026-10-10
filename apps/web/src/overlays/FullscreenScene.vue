<script setup lang="ts">
import type { SceneArt } from "./clear-sheets.js";

/*
 * A picture over the whole screen with the speaker's name plate and the lines on a gradient band
 * (Issue #371): the clear effect's ② and ③, and the scold calls that open a penalty (Issue #29).
 * With `advanceOnVeil` a click anywhere moves on (one handler on the veil: the button's click
 * bubbles up to it, so it never fires twice); without it only the button does, so a scold is
 * read to the end as before.
 */
const props = withDefaults(
  defineProps<{
    art: SceneArt;
    /** The name plate: "所属 役職", or the role alone. Also the picture's alt. */
    name: string;
    lines: readonly string[];
    buttonLabel: string;
    testid: string;
    /** A small line above the name plate (a call's 「📞 内線 — 皮膚科」). */
    caption?: string;
    advanceOnVeil?: boolean;
    disabled?: boolean;
  }>(),
  { caption: "", advanceOnVeil: false, disabled: false },
);

const emit = defineEmits<{
  next: [];
}>();

const onVeil = (): void => {
  if (props.advanceOnVeil) emit("next");
};
const onButton = (): void => {
  if (!props.advanceOnVeil) emit("next");
};
</script>

<template>
  <div
    class="veil scene"
    :class="{ tappable: advanceOnVeil }"
    :data-testid="testid"
    role="dialog"
    aria-modal="true"
    :aria-label="name"
    @click="onVeil"
  >
    <img
      :key="art.src"
      class="art"
      :class="art.fit"
      :src="art.src"
      :alt="name"
      :style="{ objectPosition: art.position }"
    />
    <div class="band">
      <div v-if="caption !== ''" class="cap">{{ caption }}</div>
      <div class="who">{{ name }}</div>
      <div class="row">
        <div class="lines">
          <p v-for="(line, i) in lines" :key="i" class="say">{{ line }}</p>
        </div>
        <button type="button" class="next" :disabled="disabled" @click="onButton">
          {{ buttonLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 字幕帯は画像に焼き込まず、ここのグラデーションで統一する（絵ごとに下端の暗さが違い、明るい絵
   でも読めるように）。テーマに追従しない固定色。 */
.scene {
  background: #000;
}
.scene.tappable {
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
/* 縦長の肖像（内線の窓の絵）は切らずに収める。余白は背景の黒。 */
.scene .art.contain {
  object-fit: contain;
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
.scene .cap {
  margin-bottom: 6px;
  font-family: var(--font-legacy);
  font-size: calc(14px * var(--fs-scale));
  color: rgba(255, 255, 255, 0.78);
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
/* 画面のどこを押しても進むときも、ボタンは「押せる」ことを見せる目印で、押せば同じく進む。 */
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
</style>
