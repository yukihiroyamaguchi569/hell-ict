<script setup lang="ts">
import { execVoices, stage4DirectorPages, stage4Labels } from "@hell-ict/content";
import { computed } from "vue";

import { portraitSrc } from "../../overlays/clear-sheets.js";
import type { DirectorWindow } from "./use-director-window.js";

/*
 * The director gives the task (mock #ov-s4-director): two pages in one window, only the words
 * and the button change. A portrait names the speaker, so the lines carry no 〔院長〕.
 */
const props = defineProps<{ director: DirectorWindow }>();

const lines = computed(() => stage4DirectorPages[props.director.page.value] ?? []);
const last = computed(() => props.director.page.value >= stage4DirectorPages.length - 1);
const portrait = execVoices.incho;
</script>

<template>
  <div class="veil callin" data-testid="s4-director">
    <div class="win" role="dialog" aria-modal="true">
      <div class="tb">
        <span class="grow">{{ stage4Labels.directorTitle }}</span>
        <span class="ctl">□ ✕</span>
      </div>
      <div class="bd">
        <div class="por">
          <div class="frame"><img :src="portraitSrc(portrait.img)" :alt="portrait.role" /></div>
          <div class="cap">
            <b>{{ portrait.role }}</b>
          </div>
        </div>
        <div class="main">
          <div v-for="(line, i) in lines" :key="`${director.page.value}-${i}`" class="say">
            {{ line }}
          </div>
        </div>
      </div>
      <div class="ft">
        <button type="button" class="btn" @click="director.press">
          {{ last ? stage4Labels.directorDone : stage4Labels.directorNext }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 院内システムの窓（mock .sysdlg / .callin）。テーマに追従しない固定色の2003年風。 */
.callin {
  background: rgba(8, 9, 10, 0.6);
  padding: 40px;
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
.tb,
.ft {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: #eef0ea;
  font-family: var(--font-legacy);
  font-size: 13px;
}
.tb {
  border-bottom: 1px solid #c8ccc4;
}
.tb .grow {
  flex: 1;
}
.tb .ctl {
  color: #8a908a;
  letter-spacing: 0.3em;
}
.ft {
  border-top: 1px solid #c8ccc4;
  justify-content: flex-end;
}
.bd {
  padding: 20px 26px 18px;
  overflow-y: auto;
  display: flex;
  gap: 24px;
  min-height: 0;
}
.main {
  flex: 1;
  min-width: 0;
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
.por .frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.por .cap {
  font-family: var(--font-legacy);
  margin-top: 7px;
  text-align: center;
  font-size: 14px;
}
.say {
  font-size: calc(17px * var(--fs-scale));
  line-height: 1.8;
}
.say + .say {
  margin-top: 10px;
}
</style>
