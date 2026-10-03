import type { GameStageId, PlayedStageId, TeamGameScene } from "@hell-ict/domain";
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

import type { Scheduler } from "../ports.js";
import type { SendOutcome } from "./use-game-session.js";

/*
 * The clear effect of a stage (mock `startClearPopups` … `finishHandoverPopup`):
 * ① the notice, moved on by itself after CLEAR_UNLOCK_MS; ② the ward's reaction and ③ the
 * executive's words, each moved on by the team; ④ after Stage 2 and 4 only, the request to change
 * who operates the PC. Closing the last sheet sends `advance {from, to}` — once.
 *
 * The clear itself is already recorded by the server (the race time never waits for the effect),
 * so nothing here is saved: a reload while the effect plays finds the same cleared state and
 * starts again from ①. The effect is keyed by the stage cleared, so the refetches that keep coming
 * while it plays do not restart it.
 */

export type ClearStep = "unlock" | "field" | "exec" | "handover";

/** How long ① stays (the mock's CLEAR_UNLOCK_MS): a notice, not something to read. */
export const CLEAR_UNLOCK_MS = 1_900;

/**
 * ③ and ④ ignore clicks this long after opening (the mock's CLEAR_POP_GRACE_MS): the double click
 * that closed the sheet before must not close this one unread.
 */
export const CLEAR_GRACE_MS = 400;

export interface ClearSequenceDeps {
  readonly scene: Readonly<Ref<TeamGameScene | null>>;
  readonly scheduler: Scheduler;
  /** Plays the sound of ① (called once per effect; the stage decides which, if any). */
  readonly onUnlock: (stage: PlayedStageId) => void;
  /** A fresh commandId for this effect's `advance` (GameSession.newCommandId). */
  readonly newCommandId: () => string;
  /** Sends `advance` under `commandId`: a press again after no answer reuses the same id. */
  readonly sendAdvance: (
    from: PlayedStageId,
    to: GameStageId,
    commandId: string,
  ) => Promise<SendOutcome>;
}

export interface ClearSequence {
  /** The sheet on screen, `null` when no effect is playing. */
  readonly step: ComputedRef<ClearStep | null>;
  /** The stage whose clear is being played. */
  readonly stage: ComputedRef<PlayedStageId | null>;
  /** `advance` is on its way: the last sheet's button waits for the answer. */
  readonly sending: ComputedRef<boolean>;
  /** The team moves on from the sheet on screen (the button, or a click on the backdrop). */
  next(): void;
}

type ClearScene = Extract<TeamGameScene, { kind: "clear-sequence" }>;

const clearSceneOf = (scene: TeamGameScene | null): ClearScene | null =>
  scene?.kind === "clear-sequence" ? scene : null;

/** Sends that may be tried again: nothing reached the server, or nothing could be read back. */
const mayRetry = (outcome: SendOutcome): boolean =>
  outcome.kind === "unavailable" || outcome.kind === "failed";

export const useClearSequence = (deps: ClearSequenceDeps): ClearSequence => {
  const step = ref<ClearStep | null>(null);
  const playing = shallowRef<ClearScene | null>(null);
  const sending = ref(false);
  /** Set once `advance` has been sent for the effect on screen; cleared only for a retry. */
  let sent = false;
  /**
   * The commandId of this effect's `advance`, kept for a press again: the first send may have
   * been applied with its answer lost, and only the same id brings that answer back
   * (`duplicate`, with the events of the first application — the red band of the next stage).
   * A fresh id would be refused as `stage-mismatch` and the band never shown.
   */
  let advanceId: string | null = null;
  /** ③ and ④ take clicks only after CLEAR_GRACE_MS. */
  let armed = false;
  let cancelTimer: () => void = () => undefined;

  const later = (task: () => void, delayMs: number): void => {
    cancelTimer();
    cancelTimer = deps.scheduler.schedule(task, delayMs);
  };

  const openGuarded = (next: "exec" | "handover"): void => {
    step.value = next;
    armed = false;
    later(() => {
      armed = true;
    }, CLEAR_GRACE_MS);
  };

  const start = (scene: ClearScene | null): void => {
    cancelTimer();
    playing.value = scene;
    sent = false;
    advanceId = null;
    sending.value = false;
    if (scene === null) {
      step.value = null;
      return;
    }
    step.value = "unlock";
    deps.onUnlock(scene.stage);
    later(() => {
      step.value = "field";
    }, CLEAR_UNLOCK_MS);
  };

  const finish = (scene: ClearScene): void => {
    if (sent) return;
    sent = true;
    sending.value = true;
    advanceId ??= deps.newCommandId();
    void deps.sendAdvance(scene.stage, scene.next, advanceId).then((outcome) => {
      // A later effect may have started meanwhile: this answer is not about it.
      if (playing.value !== scene) return;
      sending.value = false;
      // The applied answer moves the team on, and the scene with it. Only a send that got no
      // answer (or none it could read) lets the team press again, under the same commandId.
      if (mayRetry(outcome)) sent = false;
    });
  };

  const next = (): void => {
    const scene = playing.value;
    if (scene === null) return;
    if (step.value === "field") {
      openGuarded("exec");
      return;
    }
    if ((step.value !== "exec" && step.value !== "handover") || !armed) return;
    if (step.value === "exec" && scene.handover) {
      openGuarded("handover");
      return;
    }
    finish(scene);
  };

  watch(
    () => clearSceneOf(deps.scene.value),
    (scene) => {
      const current = playing.value;
      if (scene?.stage === current?.stage && scene?.next === current?.next) {
        // The same clear, refetched: keep the sheet on screen (and the same scene object, so an
        // answer still in flight is recognised as this effect's).
        return;
      }
      start(scene);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    cancelTimer();
  });

  return {
    step: computed(() => step.value),
    stage: computed(() => playing.value?.stage ?? null),
    sending: computed(() => sending.value),
    next,
  };
};
