<script setup lang="ts">
import { teamGameScene } from "@hell-ict/domain";
import { computed, onMounted, ref, watch } from "vue";

import { useAppContext } from "./app-context.js";
import {
  appScreen,
  appShellView,
  centerView,
  clearEffectScene,
  stageMissionFacts,
  welcomeAction,
} from "./app-view.js";
import ChatPane from "./chat/ChatPane.vue";
import { useClearPortraitPreload } from "./composables/use-clear-portrait-preload.js";
import { useClearSequence } from "./composables/use-clear-sequence.js";
import { useEntry } from "./composables/use-entry.js";
import { usePreferences } from "./composables/use-preferences.js";
import { useProgressReport } from "./composables/use-progress-report.js";
import { useRedBand } from "./composables/use-red-band.js";
import { useServerNow } from "./composables/use-server-now.js";
import { useSfx } from "./composables/use-sfx.js";
import { createTeamNameStore, useTeamName } from "./composables/use-team-name.js";
import EntryScreen from "./entry/EntryScreen.vue";
import { teamChipText } from "./entry/entry-view.js";
import StaleNotice from "./entry/StaleNotice.vue";
import InboxList from "./inbox/InboxList.vue";
import { useMailRead } from "./inbox/use-mail-read.js";
import { useMailSelection, useStageInbox } from "./inbox/use-stage-inbox.js";
import WelcomeScreen from "./entry/WelcomeScreen.vue";
import { clearSheets, stage1ClearResult } from "./overlays/clear-sheets.js";
import ClearSequence from "./overlays/ClearSequence.vue";
import type { OverlayId } from "./overlays/overlay-priority.js";
import OverlayHost from "./overlays/OverlayHost.vue";
import { openingWanted, progressPercent } from "./opening/opening-view.js";
import OpeningScreen from "./opening/OpeningScreen.vue";
import { OPENING_BACKDROP, PRELOAD_ASSETS } from "./opening/preload-manifest.js";
import { useOpeningPreload } from "./opening/use-opening-preload.js";
import KarubePhone from "./phs/KarubePhone.vue";
import { useKarube, useKarubeRecord } from "./phs/use-karube.js";
import HeaderBar from "./shell/HeaderBar.vue";
import LeftPane from "./shell/LeftPane.vue";
import MissionBar from "./shell/MissionBar.vue";
import { countdown } from "./shell/mission-bar-view.js";
import RedBand from "./shell/RedBand.vue";
import { clockText, raceElapsedMs } from "./shell/shell-view.js";
import ShellFrame from "./shell/ShellFrame.vue";
import ThreePane from "./shell/ThreePane.vue";
import ComingSoon from "./stages/ComingSoon.vue";
import { stageRegistry } from "./stages/registry.js";
import { useStageFrame } from "./stages/use-stage-frame.js";
import SharedFolder from "./viewer/SharedFolder.vue";
import { sharedFolderItems } from "./viewer/shared-folder-view.js";
import { provideViewer, useViewer } from "./viewer/use-viewer.js";
import ViewerOverlay from "./viewer/ViewerOverlay.vue";

const {
  session,
  stageChat,
  http,
  probeHttp,
  clock,
  storage,
  sessionStorage,
  scheduler,
  resume,
  audio,
  clipboard,
  images,
  gestureTarget,
} = useAppContext();
const viewer = useViewer({ clipboard, scheduler });
provideViewer(viewer);

const { muted, fontStep, canShrinkFont, canEnlargeFont, toggleMute, shrinkFont, enlargeFont } =
  usePreferences(storage);
const sfx = useSfx(audio, muted, gestureTarget);
/** Read before the restore starts: a team saved on this PC skips the opening (Issue #379). */
const savedTeamAtOpen = session.hasSavedTeam();
const assets = useOpeningPreload({
  backdrop: OPENING_BACKDROP,
  assets: PRELOAD_ASSETS,
  images,
  audio,
  scheduler,
});
const opening = computed(() =>
  openingWanted({ savedTeam: savedTeamAtOpen, finished: assets.finished.value }),
);
const openingPercent = computed(() => progressPercent(assets.settled.value, assets.total));
const teamNames = createTeamNameStore(storage);
const teamName = useTeamName(session.teamCode, teamNames);
const entry = useEntry({ session, probeHttp, teamName });
useProgressReport({ http, clock, scheduler, resume, session, teamName: teamName.name });
const serverNow = useServerNow(session.serverClock, scheduler);

const { notice, error } = entry;
const view = session.view;
const screen = computed(() => appScreen(session.status.value, view.value));
const mail = useMailSelection();
const karubeRecord = useKarubeRecord(sessionStorage, session.teamCode);
const frame = useStageFrame(
  () =>
    view.value !== null && (screen.value === "welcome" || screen.value === "game")
      ? view.value.state.game.stage
      : null,
  stageRegistry,
  {
    session,
    serverNow,
    sessionStorage,
    scheduler,
    mail,
    sfx,
    karubeRead: karubeRecord.read,
    teamName: teamName.name,
    chatPiiBlocks: stageChat.piiBlocks,
  },
);
const karube = useKarube({
  record: karubeRecord,
  instance: () => frame.instance.value,
  scheduler,
  onRing: () => {
    sfx.play("mobile-phone-ringtone1");
  },
});
const viewerToolbar = computed(() => frame.viewerToolbar(viewer.openId.value));
const inbox = useStageInbox({
  instance: frame.instance,
  mail,
  mailRead: useMailRead(sessionStorage, session.teamCode),
  openViewer: (doc) => {
    viewer.open(doc);
  },
});
/** 「メールを開く」 was pressed while the Prologue is not built: 準備中 without sending. */
const welcomeLeft = ref(false);
watch(session.teamCode, () => {
  welcomeLeft.value = false;
});
const center = computed(() => centerView(screen.value, frame.module.value, welcomeLeft.value));
const shell = computed(() => appShellView(view.value, frame.rightOverride.value));
const chip = computed(() => teamChipText(teamName.name.value, session.teamCode.value));
const storedName = (teamCode: string): string => teamNames.read(teamCode);
const scene = computed(() =>
  clearEffectScene(
    view.value === null ? null : teamGameScene(view.value.state),
    frame.module.value,
    frame.clearHeld.value,
  ),
);

const clear = useClearSequence({
  scene,
  scheduler,
  onUnlock: (stage) => {
    const name = clearSheets(stage, null).sfx;
    if (name !== null) sfx.play(name);
  },
  newCommandId: () => session.newCommandId(),
  sendAdvance: (from, to, commandId) => session.send({ type: "advance", from, to }, commandId),
});
useClearPortraitPreload({
  stage: () => view.value?.state.game.stage ?? null,
  preloader: images,
  resume,
});
const sheets = computed(() => {
  const stage = clear.stage.value;
  return stage === null || view.value === null
    ? null
    : clearSheets(stage, stage1ClearResult(view.value.state));
});

const band = useRedBand({
  scheduler,
  subscribe: (listener) => session.onEvents(listener),
  onShow: () => {
    sfx.play("emergency-alert1");
  },
});

const mission = computed(() =>
  screen.value === "game" && view.value !== null
    ? stageMissionFacts(view.value.state, frame.focus.value, frame.module.value)
    : null,
);
const missionCountdown = computed(() => {
  const deadline = mission.value?.deadline ?? null;
  return deadline === null ? null : countdown(deadline, serverNow.value);
});
const folder = computed(() =>
  view.value === null ? [] : sharedFolderItems(view.value.state.game.stage),
);
const elapsedMs = computed(() =>
  view.value === null ? null : raceElapsedMs(view.value.state, serverNow.value),
);

const overlays = computed(() => {
  const requested: OverlayId[] = [];
  if (screen.value === "stale") requested.push("stale");
  if (opening.value) requested.push("opening");
  if (screen.value === "entry") requested.push("entry");
  if (clear.step.value !== null) requested.push("clear");
  if (frame.overlayWanted.value) requested.push("stage");
  if (viewer.openId.value !== null) requested.push("viewer");
  return requested;
});

onMounted(() => {
  void entry.start();
});

const onEnter = (teamCode: string, name: string): void => {
  void entry.enter(teamCode, name);
};
const onRetry = (): void => {
  void entry.retry();
};
const openInbox = (): void => {
  if (welcomeAction(stageRegistry.prologue) === "coming-soon") {
    welcomeLeft.value = true;
    return;
  }
  void session.send({ type: "inbox.open" });
};
const reload = (): void => {
  window.location.reload();
};
</script>

<template>
  <ShellFrame :mode="shell.mode" :font-step="fontStep">
    <template #header>
      <HeaderBar
        :fever="shell.fever"
        :crescendo="shell.crescendo"
        :muted="muted"
        :can-shrink-font="canShrinkFont"
        :can-enlarge-font="canEnlargeFont"
        :clock="clockText(elapsedMs)"
        :clock-idle="elapsedMs === null"
        :team-name="chip"
        @toggle-mute="toggleMute"
        @shrink-font="shrinkFont"
        @enlarge-font="enlargeFont"
      />
    </template>
    <ThreePane :left="shell.left" :right="shell.right">
      <template #left>
        <LeftPane>
          <template #inbox>
            <InboxList
              v-if="inbox.view.value !== null"
              :view="inbox.view.value"
              :stage="shell.stage"
              @open="inbox.select"
            />
          </template>
          <SharedFolder :items="folder" @open="viewer.open" />
        </LeftPane>
      </template>
      <WelcomeScreen v-if="center === 'welcome'" @open-inbox="openInbox" />
      <MissionBar v-if="mission !== null" :facts="mission" :countdown="missionCountdown" />
      <ComingSoon v-if="center === 'coming-soon'" />
      <component
        :is="frame.instance.value.center"
        v-else-if="center === 'stage' && frame.instance.value !== null"
      />
      <KarubePhone
        v-if="karube.visible.value"
        :open="karube.open.value"
        :badge="karube.badge.value"
        :log="karube.log.value"
        @toggle="karube.toggle"
        @reply="karube.reply"
      />
      <template #right>
        <ChatPane :on-submit="frame.chatSubmit.value" :chat="frame.chat.value" />
      </template>
    </ThreePane>
    <RedBand :phase="band.phase.value" :text="band.text.value" />
    <OverlayHost :requested="overlays">
      <template #stale>
        <StaleNotice @reload="reload" />
      </template>
      <template #opening>
        <OpeningScreen :percent="openingPercent" />
      </template>
      <template #entry>
        <EntryScreen
          :notice="notice"
          :error="error"
          :stored-name="storedName"
          @enter="onEnter"
          @retry="onRetry"
        />
      </template>
      <template #clear>
        <ClearSequence
          v-if="clear.step.value !== null && sheets !== null"
          :step="clear.step.value"
          :sheets="sheets"
          :sending="clear.sending.value"
          @next="clear.next"
        />
      </template>
      <template #stage>
        <component :is="frame.instance.value?.overlay" v-if="frame.instance.value?.overlay" />
      </template>
      <template #viewer>
        <ViewerOverlay
          v-if="viewer.sheet.value !== null"
          :sheet="viewer.sheet.value"
          :picked="viewer.picked.value"
          :copy-label="viewer.copyLabel.value"
          :columns-label="viewer.columnsLabel.value"
          @close="viewer.close"
          @copy="viewer.copyAll"
          @copy-columns="viewer.copyColumns"
          @toggle-column="viewer.toggleColumn"
        >
          <template #toolbar>
            <component :is="viewerToolbar" v-if="viewerToolbar !== null" />
          </template>
        </ViewerOverlay>
      </template>
    </OverlayHost>
  </ShellFrame>
</template>
