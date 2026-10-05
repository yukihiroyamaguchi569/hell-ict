import { stage3Penalty } from "@hell-ict/content";
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

import type { GameCommandInput, SendOutcome } from "../../composables/use-game-session.js";
import type { Sfx } from "../../composables/use-sfx.js";
import type { Scheduler } from "../../ports.js";
import { allFilled, finishFilling, startFilling, startShelf, type BottleShelf } from "./bottles.js";

/** The bottle's own quiet sound: it plays forty times (mock S3_BOTTLE_SFX / _VOL). */
const BOTTLE_SFX_VOLUME = 0.22;

export interface BottlePenaltyDeps {
  /** The penalty window is on screen. Each time it comes up the shelf starts over. */
  readonly active: () => boolean;
  readonly send: (command: GameCommandInput, commandId?: string) => Promise<SendOutcome>;
  readonly newCommandId: () => string;
  readonly serverNow: Readonly<Ref<number>>;
  readonly scheduler: Scheduler;
  readonly sfx: Sfx;
  /** Every bottle is full and `s3.finish-penalty` is about to be sent (again, on a retry). */
  readonly onFinishing: () => void;
  /** The answer to it: `true` when the server has the penalty paid, `false` when not delivered. */
  readonly onFinished: (paid: boolean) => void;
}

export interface BottlePenalty {
  readonly shelf: Readonly<Ref<BottleShelf>>;
  readonly note: Readonly<Ref<string>>;
  /** A wave has just landed: the note flashes and its ward slides in (mock s3FreshWard). */
  readonly freshWard: Readonly<Ref<string | null>>;
  /**
   * The time paid so far (the penalty's clock counts up, not down), counted from the first redraw
   * of the server's time after the window came up.
   */
  readonly elapsedMs: ComputedRef<number>;
  /** Every bottle is full but `s3.finish-penalty` did not get through: offer to send it again. */
  readonly failed: Readonly<Ref<boolean>>;
  readonly fill: (index: number) => void;
  readonly retry: () => void;
}

/**
 * The Stage 3 penalty (mock startPenalty / fillBottle / finishPenalty): fill every bottle, then
 * tell the server. Nothing but the server's `penalties.s3` ends it: a reload shows the window
 * again with the shelf full of work (user decision 12), and the submission stays under it.
 */
export const useBottlePenalty = (deps: BottlePenaltyDeps): BottlePenalty => {
  const shelf = shallowRef<BottleShelf>(startShelf());
  const note = ref<string>(stage3Penalty.note);
  const freshWard = ref<string | null>(null);
  const failed = ref(false);
  /** Server epoch ms the clock counts from, or `null` until the first redraw after the start. */
  const startedAt = ref<number | null>(null);
  const timers = new Set<() => void>();
  let commandId: string | null = null;

  const later = (task: () => void, delayMs: number): void => {
    const cancel = deps.scheduler.schedule(() => {
      timers.delete(cancel);
      task();
    }, delayMs);
    timers.add(cancel);
  };
  const cancelAll = (): void => {
    for (const cancel of timers) cancel();
    timers.clear();
  };
  onScopeDispose(cancelAll);

  watch(
    deps.active,
    (active) => {
      // Hidden (paid in another tab, or the stage left): no bottle may finish and report it.
      cancelAll();
      if (!active) return;
      shelf.value = startShelf();
      note.value = stage3Penalty.note;
      freshWard.value = null;
      failed.value = false;
      startedAt.value = null;
      commandId = null;
    },
    { immediate: true },
  );
  // The clock starts at the first redraw of the server's time after the start, not at the start
  // itself: after a reload the stage is built before the offset to the server is learnt, and the
  // time read then is the PC's own (the clock would open at the PC's lag behind the server).
  watch(deps.serverNow, (now) => {
    startedAt.value ??= now;
  });

  const finish = async (): Promise<void> => {
    failed.value = false;
    commandId ??= deps.newCommandId();
    deps.onFinishing();
    const outcome = await deps.send({ type: "s3.finish-penalty" }, commandId);
    const paid = outcome.kind === "done";
    failed.value = !paid;
    deps.onFinished(paid);
  };

  const land = (ward: string): void => {
    note.value = `${ward}${stage3Penalty.waveNoteSuffix}`;
    deps.sfx.play("cancel");
    freshWard.value = ward;
    later(() => {
      freshWard.value = null;
    }, stage3Penalty.waveFlashMs);
  };

  return {
    shelf,
    note,
    freshWard,
    elapsedMs: computed(() =>
      startedAt.value === null ? 0 : deps.serverNow.value - startedAt.value,
    ),
    failed,
    fill(index) {
      const filling = startFilling(shelf.value, index);
      if (filling === null) return;
      deps.sfx.play("decision1", BOTTLE_SFX_VOLUME);
      shelf.value = filling;
      later(() => {
        const { shelf: next, landed } = finishFilling(shelf.value, index);
        shelf.value = next;
        if (landed !== null) land(landed);
        if (allFilled(next)) void finish();
      }, stage3Penalty.fillMs);
    },
    retry() {
      void finish();
    },
  };
};
