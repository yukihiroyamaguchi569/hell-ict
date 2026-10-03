<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { isImeComposing } from "../ime-composing.js";
import {
  nameAfterCodeChange,
  TEAM_CODE_LENGTH,
  TEAM_NAME_MAX,
  type EntryNotice,
} from "./entry-view.js";

/*
 * The entry screen (mock #ov-entry): the team code the facilitator reads out, one box per digit,
 * and the team's name. It covers the whole screen, header included. What it says and allows
 * comes in `notice`; the form only collects the input.
 */
const props = defineProps<{
  notice: EntryNotice;
  /** Why the last try did not go through ("" for none). */
  error: string;
  /** The name this PC kept for a code ("" for none): filled in until the team types one. */
  storedName: (teamCode: string) => string;
}>();

const emit = defineEmits<{
  enter: [teamCode: string, teamName: string];
  retry: [];
}>();

// Starts empty (mock, 2026-08-22): a prefilled code that a team forgets to change sends every
// team into the same room.
const digits = ref<string[]>(Array.from({ length: TEAM_CODE_LENGTH }, () => ""));
const teamName = ref("");
let nameTyped = false;

const teamCode = computed(() => digits.value.map((digit) => digit.trim()).join(""));

watch(teamCode, (code) => {
  teamName.value = nameAfterCodeChange({
    current: teamName.value,
    stored: props.storedName(code),
    typed: nameTyped,
  });
});

/** Typing a digit moves on to the next box, so the code can be typed as it is read out. */
const onDigitInput = (event: Event): void => {
  const box = event.target;
  if (!(box instanceof HTMLInputElement) || box.value === "") return;
  const next = box.nextElementSibling;
  if (next instanceof HTMLInputElement) next.focus();
};

/** Backspace in an empty box goes back to the previous one. */
const onDigitBackspace = (event: KeyboardEvent): void => {
  const box = event.target;
  if (!(box instanceof HTMLInputElement) || box.value !== "") return;
  const previous = box.previousElementSibling;
  if (previous instanceof HTMLInputElement) previous.focus();
};

const onNameInput = (): void => {
  nameTyped = true;
};

const submit = (): void => {
  if (props.notice.canEnter) emit("enter", teamCode.value, teamName.value);
};

/** Enter presses [入室する] from any box, but not the Enter that confirms an IME conversion. */
const onEnterKey = (event: KeyboardEvent): void => {
  if (isImeComposing(event)) return;
  event.preventDefault();
  submit();
};
</script>

<template>
  <div class="veil entry">
    <div class="logo">
      <div class="h">🏥 聖クロノス総合病院</div>
      <div class="s">感染制御チーム</div>
    </div>
    <div class="lab">チームコードを入力</div>
    <div class="code" role="group" aria-label="チームコード">
      <input
        v-for="(_, index) in digits"
        :key="index"
        v-model="digits[index]"
        maxlength="1"
        inputmode="numeric"
        autocomplete="off"
        :aria-label="`チームコード ${String(index + 1)}桁目`"
        @input="onDigitInput"
        @keydown.backspace="onDigitBackspace"
        @keydown.enter="onEnterKey"
      />
    </div>
    <div class="lab">チーム名（チームで相談して決めてください）</div>
    <div class="teamname">
      <input
        v-model="teamName"
        type="text"
        :maxlength="TEAM_NAME_MAX"
        autocomplete="off"
        placeholder="例：発熱対策室"
        aria-label="チーム名"
        @input="onNameInput"
        @keydown.enter="onEnterKey"
      />
    </div>
    <div v-if="error !== ''" class="entry-error" role="alert">{{ error }}</div>
    <div v-if="notice.text !== ''" class="entry-probe" :class="{ bad: notice.bad }" role="status">
      {{ notice.text }}
    </div>
    <button type="button" class="btn" :disabled="!notice.canEnter" @click="submit">入室する</button>
    <div v-if="notice.retry !== null" class="probe-actions">
      <button type="button" class="btn ghost" @click="$emit('retry')">再試行</button>
    </div>
  </div>
</template>

<style scoped>
.entry {
  background: var(--bg);
  flex-direction: column;
  gap: 26px;
  transition: background-color 0.78s ease;
}
.logo {
  text-align: center;
}
.logo .h {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.logo .s {
  font-size: 17px;
  color: var(--fg-muted);
  margin-top: 5px;
}
.lab {
  font-size: 15px;
  color: var(--fg-muted);
  text-align: center;
}
.code {
  display: flex;
  gap: 9px;
  justify-content: center;
}
.code input {
  width: 54px;
  height: 68px;
  text-align: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  color: var(--fg);
  font-family: var(--font-num);
  font-size: 32px;
  font-weight: 600;
}
/* コード欄と同じ幅（54px×6＋gap 9px×5＝369px）に揃え、入室画面の中心線を乱さない。 */
.teamname {
  display: flex;
  justify-content: center;
}
.teamname input {
  width: 369px;
  height: 46px;
  padding: 0 12px;
  text-align: center;
  background: var(--surface);
  border: 1px solid var(--rule);
  color: var(--fg);
  font-family: inherit;
  font-size: 18px;
  font-weight: 600;
}
.teamname input::placeholder {
  color: var(--fg-muted);
  font-weight: 400;
}
.entry-error {
  font-size: 14px;
  color: #c1121f;
  text-align: center;
  max-width: 42ch;
}
/* 疎通確認と入室の進み具合。確認中は淡く、失敗したときだけ赤くする。 */
.entry-probe {
  font-size: 14px;
  color: var(--fg-muted);
  text-align: center;
  max-width: 42ch;
}
.entry-probe.bad {
  color: #c1121f;
}
.probe-actions {
  display: flex;
  justify-content: center;
}
</style>
