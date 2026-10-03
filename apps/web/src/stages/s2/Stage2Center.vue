<script setup lang="ts">
import { stage2Brief, stage2Columns, stage2GridSize, stage2WorkText } from "@hell-ict/content";
import { computed, ref, watch } from "vue";

import { isImeComposing } from "../../ime-composing.js";
import VerdictBox from "../../verdict/VerdictBox.vue";
import { injectViewer } from "../../viewer/use-viewer.js";
import { cellKey } from "./s2-view.js";
import type { Stage2 } from "./use-stage2.js";

/*
 * Stage 2's centre pane (mock renderStage2Excel / drawGrid): the brief, the editable grid, and
 * after a submission the folded form with the verdict. The deadline is the mission bar's.
 * Moving between cells is Tab and Enter only (Enter goes one row down), as in the mock.
 */
const props = defineProps<{ stage: Stage2 }>();
const viewer = injectViewer();
const gridEl = ref<HTMLElement | null>(null);

const grid = computed(() => props.stage.grid.value);
const verdict = computed(() => props.stage.verdict.value);
const size = computed(() => stage2GridSize(grid.value.length, stage2Columns.length));

const onInput = (row: number, column: number, event: Event): void => {
  if (event.target instanceof HTMLInputElement) props.stage.edit(row, column, event.target.value);
};

const onEnter = (row: number, column: number, event: KeyboardEvent): void => {
  // The Enter that confirms an IME conversion stays in the cell.
  if (isImeComposing(event)) return;
  event.preventDefault();
  gridEl.value
    ?.querySelector<HTMLInputElement>(
      `input[data-r="${String(row + 1)}"][data-c="${String(column)}"]`,
    )
    ?.focus();
};

/** Several lines pasted into a cell go to the grid as a table (mock paste handler); one line stays in the cell. */
const onPaste = (event: ClipboardEvent): void => {
  const text = event.clipboardData?.getData("text") ?? "";
  if (!text.trim().includes("\n")) return;
  event.preventDefault();
  props.stage.sendTable(text);
};

/** A table that went in flashes green and comes into view (mock `.grid.landed`), each time anew. */
watch(
  () => props.stage.landed.value,
  () => {
    const el = gridEl.value;
    if (el === null) return;
    el.classList.remove("landed");
    // Reading offsetWidth forces a reflow so the removed class takes effect and the animation restarts.
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- the read is the side effect
    void el.offsetWidth;
    el.classList.add("landed");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  },
  { flush: "post" },
);

const onReset = (): void => {
  if (window.confirm(stage2WorkText.resetConfirm)) props.stage.reset();
};
</script>

<template>
  <div class="work" data-testid="s2-work">
    <div class="brief">{{ stage2Brief }}</div>
    <template v-if="verdict === null">
      <div class="box">
        <div class="hd">{{ stage2WorkText.submitHeading }}</div>
        <div ref="gridEl" class="grid" data-testid="s2-grid" @paste="onPaste">
          <table>
            <thead>
              <tr>
                <th></th>
                <th v-for="column in stage2Columns" :key="column">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(cells, r) in grid" :key="r">
                <td class="n">
                  <button
                    type="button"
                    :title="stage2WorkText.deleteRow"
                    @click="stage.deleteRow(r)"
                  >
                    ✕ {{ r + 1 }}
                  </button>
                </td>
                <td
                  v-for="(value, c) in cells"
                  :key="c"
                  :class="{ hot: stage.hot.value.has(cellKey(r, c)) }"
                >
                  <input
                    :value="value"
                    :data-r="r"
                    :data-c="c"
                    :aria-label="`${r + 1} ${stage2Columns[c]}`"
                    @input="onInput(r, c, $event)"
                    @keydown.enter="onEnter(r, c, $event)"
                  />
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="7">
                  <button type="button" @click="stage.addRow()">{{ stage2WorkText.addRow }}</button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div v-if="stage.pasteError.value !== null" class="paste-bar" data-testid="s2-paste-error">
          {{ stage.pasteError.value }}
        </div>
        <div class="recog" data-testid="s2-size">{{ size }}</div>
      </div>
      <div class="row-end">
        <button type="button" class="btn ghost" @click="viewer.open('main')">
          {{ stage2WorkText.openAttachment }}
        </button>
        <button type="button" class="btn ghost" @click="onReset">{{ stage2WorkText.reset }}</button>
        <button type="button" class="btn" @click="stage.submit()">
          {{ stage2WorkText.submit }}
        </button>
      </div>
    </template>
    <template v-else>
      <div class="folded">
        <span class="grow">{{ stage2WorkText.submitted(size) }}</span>
        <button
          v-if="verdict.kind === 'rejected'"
          type="button"
          class="btn ghost"
          @click="stage.reopen()"
        >
          {{ stage2WorkText.reopen }}
        </button>
      </div>
      <VerdictBox :verdict="verdict" />
    </template>
  </div>
</template>

<style scoped>
/* 下の余白は院内連絡先（苅部さんのバー）を避けるため（モック .work、Issue #93）。 */
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
.box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}
.box > .hd {
  padding: 8px 13px;
  font-size: calc(13px * var(--fs-scale));
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--fg-note);
  border-bottom: 1px solid var(--rule);
}
.recog {
  font-family: var(--font-num);
  font-size: calc(13px * var(--fs-scale));
  color: var(--fg-note);
  padding: 0 13px 11px;
  min-height: 1.4em;
}
/* 提出グリッド：手作業ルートの実体。直せるからこそ、直しきれないことが分かる。 */
.grid {
  max-height: 268px;
  overflow: auto;
}
.grid table {
  border-collapse: collapse;
  width: 100%;
  font-family: var(--font-num);
  font-size: 13px;
}
.grid th,
.grid td {
  border: 1px solid var(--rule);
  padding: 0;
}
.grid th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-2);
  font-size: 12px;
  font-weight: 700;
  color: var(--fg-note);
  padding: 5px 7px;
  text-align: left;
  white-space: nowrap;
}
.grid td input {
  width: 100%;
  background: transparent;
  color: var(--fg);
  border: 0;
  padding: 5px 7px;
  font-family: inherit;
  font-size: inherit;
}
.grid td input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
/* NG のセルは橙で光る。「直せ」であって「間違えた」ではないので、赤も音も付けない。 */
.grid td.hot {
  background: color-mix(in srgb, var(--warn) 22%, transparent);
}
.grid td.hot input {
  font-weight: 700;
}
/* 流し込んだ直後だけ緑で光らせる。橙（.hot）は「直せ」の色なので使わない。 */
@keyframes grid-landed {
  from {
    background: color-mix(in srgb, var(--ok) 24%, transparent);
  }
  to {
    background: transparent;
  }
}
.grid.landed {
  animation: grid-landed 0.9s ease-out;
}
/* 貼った表が読めなかった理由。次に表が入れば消える（閉じるボタンは持たない）。 */
.paste-bar {
  border-top: 1px solid var(--rule);
  padding: 9px 13px;
  font-family: var(--font-num);
  font-size: 13px;
  color: var(--warn);
}
.grid .n {
  width: 1%;
  white-space: nowrap;
  background: var(--surface-2);
}
.grid .n button,
.grid tfoot button {
  background: transparent;
  border: 0;
  color: var(--fg-note);
  font-family: var(--font-num);
}
.grid .n button {
  font-size: 12px;
  padding: 4px 6px;
  letter-spacing: 0.06em;
}
.grid .n button:hover {
  color: var(--warn);
}
.grid tfoot button {
  font-size: 13px;
  padding: 7px 9px;
}
.grid tfoot button:hover {
  color: var(--fg);
}
/* 提出したらフォームを1行に畳み、判定を1画面に収める。 */
.folded {
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--rule);
  background: var(--surface);
  padding: 11px 13px;
  font-family: var(--font-num);
  font-size: 14px;
  color: var(--fg-note);
}
.folded .grow {
  flex: 1;
}
.row-end {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  align-items: center;
}
.btn {
  background: var(--accent);
  color: #fff;
  border: 1px solid var(--accent);
  padding: 11px 26px;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.btn:hover {
  filter: brightness(1.12);
}
.btn.ghost {
  background: transparent;
  color: var(--fg);
  border-color: var(--rule);
  font-weight: 500;
}
.btn.ghost:hover {
  background: var(--surface-2);
  filter: none;
}
</style>
