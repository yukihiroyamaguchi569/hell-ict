<script setup lang="ts">
/*
 * The game master reset the team after this tab joined (mock #ov-stale). No write goes through
 * any more, so there is no way to close this: a notice that can be closed would be a lie.
 * The only way on is a reload.
 */
defineEmits<{
  reload: [];
}>();
</script>

<template>
  <div class="veil sysdlg" role="alertdialog" aria-labelledby="stale-title">
    <div class="win">
      <div class="tb">
        <span id="stale-title" class="grow">システム通知</span>
        <span class="ctl" aria-hidden="true">□ ✕</span>
      </div>
      <div class="bd">
        <p>この端末の状態は古くなっています。ページを再読み込みしてください。</p>
        <p>
          対策本部がこのチームの進行を初期状態へ戻しました。再読み込みすると、最初から開始できます。
        </p>
      </div>
      <div class="ft">
        <button type="button" class="btn" @click="$emit('reload')">再読み込みする</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 院内システムのウィンドウ（2003年風）。器のテーマに依存しない固定色。 */
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
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid #c8ccc4;
  background: #eef0ea;
  font-family: var(--font-legacy);
  font-size: 13px;
}
.tb .grow {
  flex: 1;
}
.tb .ctl {
  color: #8a908a;
  letter-spacing: 0.3em;
}
.bd {
  padding: 20px 26px 18px;
  font-size: calc(17px * var(--fs-scale));
  line-height: 1.8;
}
.bd p {
  margin: 0;
}
.bd p + p {
  margin-top: 10px;
}
.ft {
  border-top: 1px solid #c8ccc4;
  background: #eef0ea;
  padding: 11px 14px;
  display: flex;
  justify-content: flex-end;
}
</style>
