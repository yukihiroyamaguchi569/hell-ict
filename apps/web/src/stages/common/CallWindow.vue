<script setup lang="ts">
import { portraitSrc } from "../../overlays/clear-sheets.js";

/*
 * An internal call with the caller's portrait (mock .sysdlg.callin: Stage 3's #ov-s3notice and
 * #ov-s3scold, and the like in other stages). One way and read to the end: it closes only from
 * its button. The look is the clear effect's 2003 window (ClearSequence.vue), copied for now.
 */
withDefaults(
  defineProps<{
    call: { readonly tb: string; readonly img: string; readonly role: string };
    lines: readonly string[];
    closeLabel: string;
    /** The E2E's handle on this window (Stage 3's is the default). */
    testid?: string;
    /** The caller's organisation, a small line above the role (mock `.cap`: 病院執行部). */
    org?: string;
  }>(),
  { testid: "s3-call", org: "" },
);
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="veil sysdlg callin" :data-testid="testid">
    <div class="win" role="dialog" aria-modal="true">
      <div class="tb">
        <span class="grow">{{ call.tb }}</span>
        <span class="ctl">□ ✕</span>
      </div>
      <div class="bd">
        <div class="por">
          <div class="frame"><img :src="portraitSrc(call.img)" :alt="call.role" /></div>
          <div class="cap">
            <span v-if="org !== ''" class="org">{{ org }}</span>
            <b>{{ call.role }}</b>
          </div>
        </div>
        <div class="main">
          <div v-for="(line, i) in lines" :key="i" class="say">{{ line }}</div>
        </div>
      </div>
      <div class="ft">
        <button type="button" class="btn" @click="emit('close')">{{ closeLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sysdlg {
  padding: 40px;
  background: rgba(8, 9, 10, 0.6);
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
.tb {
  display: flex;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid #c8ccc4;
  background: #eef0ea;
  font-family: var(--font-legacy);
  font-size: 13px;
}
.grow {
  flex: 1;
}
.ctl {
  color: #8a908a;
  letter-spacing: 0.3em;
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
.frame {
  width: 138px;
  height: 150px;
  border: 1px solid #b3b8b0;
  background: #f0f1ec;
}
.frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cap {
  font-family: var(--font-legacy);
  font-size: 14px;
  margin-top: 7px;
  text-align: center;
}
.org {
  display: block;
  font-size: 12px;
  line-height: 1.6;
  color: #6b736e;
}
.say {
  font-size: calc(17px * var(--fs-scale));
  line-height: 1.8;
}
.say + .say {
  margin-top: 10px;
}
</style>
