<script setup lang="ts">
import { VIEWER_LABELS, type ViewerSheet } from "./viewer-view.js";

/*
 * The attachment viewer (mock #ov-viewer): a 2003-style window that only reads. What it shows and
 * what the buttons do live in use-viewer / viewer-view; this draws them. The `toolbar` slot sits
 * left of [コピー] for a stage's own button (Stage 2's [表に追加]).
 */
defineProps<{
  sheet: ViewerSheet;
  picked: readonly boolean[];
  copyLabel: string;
  columnsLabel: string;
}>();

defineEmits<{
  close: [];
  copy: [];
  copyColumns: [];
  toggleColumn: [index: number];
}>();
</script>

<template>
  <div class="veil viewer" data-testid="viewer">
    <div class="win" role="dialog" aria-modal="true" aria-labelledby="viewer-name">
      <div class="tb">
        <span id="viewer-name" class="grow" data-testid="viewer-name">{{ sheet.name }}</span>
        <slot name="toolbar" />
        <button v-if="sheet.copyable" type="button" @click="$emit('copy')">{{ copyLabel }}</button>
        <button type="button" @click="$emit('close')">{{ VIEWER_LABELS.close }}</button>
      </div>
      <div v-if="sheet.table !== null" class="cols" data-testid="viewer-cols">
        <span class="lab">{{ VIEWER_LABELS.columnsHeading }}</span>
        <div class="picks">
          <label v-for="(heading, i) in sheet.table.header" :key="i">
            <input
              type="checkbox"
              :checked="picked[i] === true"
              @change="$emit('toggleColumn', i)"
            />{{ heading }}
          </label>
        </div>
        <button type="button" @click="$emit('copyColumns')">{{ columnsLabel }}</button>
      </div>
      <div class="sheet">
        <pre :class="{ wrap: sheet.wrap }" data-testid="viewer-text">{{ sheet.text }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 院内の文書ビューア（2003年風）。器のテーマに追従しない固定色。 */
.viewer {
  background: rgba(8, 9, 10, 0.6);
  padding: 46px;
}
.win {
  width: 100%;
  max-width: 900px;
  background: #fbfbf8;
  color: #16181a;
  border: 1px solid #9aa0a6;
  display: flex;
  flex-direction: column;
  max-height: 100%;
}
.tb {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid #c8ccc4;
  font-family: var(--font-legacy);
  font-size: 13px;
  word-break: break-all;
}
.tb .grow {
  flex: 1;
}
.tb :deep(button),
.cols button {
  background: #f0f1ec;
  border: 1px solid #b3b8b0;
  color: #16181a;
  font-size: 13px;
  padding: 5px 11px;
  font-family: var(--font-ui);
  cursor: pointer;
}
.tb :deep(button:hover),
.cols button:hover {
  background: #e3e5df;
}
/* 列選択コピーの帯。表を見るより先に「列ごとに扱える」と気づかせるため、本文の上に置く。 */
.cols {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 8px 12px;
  border-bottom: 1px solid #c8ccc4;
  background: #f4f5f0;
  font-family: var(--font-legacy);
  font-size: 12px;
  color: #4a524c;
}
.cols .lab {
  color: #6a726c;
}
.cols .picks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  flex: 1;
}
.cols label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #16181a;
  cursor: pointer;
}
.cols input {
  accent-color: #4a5d52;
}
.sheet {
  overflow: auto;
  padding: 14px;
}
pre {
  margin: 0;
  font-family: var(--font-legacy);
  font-size: calc(13px * var(--fs-scale));
  line-height: 1.95;
  white-space: pre;
}
/* 行に意味の無い文章だけ折り返す。タブ区切りの表は列がずれるので折り返さない。 */
pre.wrap {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
