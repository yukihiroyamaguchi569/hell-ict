import { stage5IncidentReport, stage5Penalty, stage5ReportVerdicts } from "@hell-ict/content";
import { computed, onScopeDispose, readonly, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

import type { GameCommandInput, SendOutcome } from "../../composables/use-game-session.js";
import type { Sfx } from "../../composables/use-sfx.js";
import type { Scheduler } from "../../ports.js";
import type { Verdict } from "../../verdict/verdict.js";
import { PENALTY_DONE_MS } from "../penalty/penalty-done.js";
import { reportResult, submitVerdict } from "./s5-view.js";
import { useSubmission } from "./use-submission.js";

export interface RedactPenaltyDeps {
  /** The server has the penalty running. Each time it starts, the report starts clean. */
  readonly active: () => boolean;
  readonly send: (command: GameCommandInput, commandId: string) => Promise<SendOutcome>;
  readonly newCommandId: () => string;
  readonly serverNow: Readonly<Ref<number>>;
  readonly scheduler: Scheduler;
  readonly sfx: Sfx;
}

export interface RedactPenalty {
  /** The indices of `stage5IncidentReport` blacked out. In memory only (user decision 5). */
  readonly masked: Readonly<Ref<ReadonlySet<number>>>;
  readonly sending: Readonly<Ref<boolean>>;
  readonly verdict: ComputedRef<Verdict | null>;
  /**
   * The time paid so far (the penalty's clock counts up), from when this screen saw the penalty
   * start (the alarm and the scold count), counted from the first redraw of the server's time
   * after it. A reload starts it over at 0, as it does the report.
   */
  readonly elapsedMs: ComputedRef<number>;
  /**
   * The report went through: 「送信しました」 and 「罰ゲーム完了！」 show together for
   * `STAGE5_PENALTY_HOLD_MS` before the window closes, although the server has the penalty done already.
   */
  readonly holding: Readonly<Ref<boolean>>;
  toggle(index: number): void;
  submit(): void;
}

/**
 * How long the window stays once the report went through. 「送信しました」 (`sentMs`) and
 * 「罰ゲーム完了！」 (PENALTY_DONE_MS) show at the same time, so the wait is the longer of the two.
 */
export const STAGE5_PENALTY_HOLD_MS = Math.max(stage5Penalty.sentMs, PENALTY_DONE_MS);

/** The segments that can be pressed: the plain text between them cannot. */
const clickable = (index: number): boolean => stage5IncidentReport[index]?.pii !== undefined;

/**
 * The Stage 5 penalty (mock startS5Penalty / toggleRedact / submitReport): black out the personal
 * data of the incident report and send it. Only the server judges it (`s5.submit-report`).
 */
export const useRedactPenalty = (deps: RedactPenaltyDeps): RedactPenalty => {
  const masked = shallowRef<ReadonlySet<number>>(new Set());
  const holding = ref(false);
  /** Server epoch ms the clock counts from, or `null` until the first redraw after the start. */
  const startedAt = ref<number | null>(null);
  let cancelHold: () => void = () => undefined;
  onScopeDispose(() => {
    cancelHold();
  });

  const box = useSubmission({
    newCommandId: deps.newCommandId,
    read: reportResult,
    onResult: (result) => {
      if (result.kind === "sent-back") deps.sfx.play("cancel");
      if (result.kind !== "passed") return;
      holding.value = true;
      cancelHold = deps.scheduler.schedule(() => {
        holding.value = false;
      }, STAGE5_PENALTY_HOLD_MS);
    },
  });

  // Only a start resets it: the end (the server's `done`) comes before 「送信しました」 shows.
  watch(
    deps.active,
    (running) => {
      if (!running) return;
      cancelHold();
      box.reset();
      masked.value = new Set();
      holding.value = false;
      startedAt.value = null;
    },
    { immediate: true },
  );
  // The clock starts at the first redraw of the server's time after the start, not at the start
  // itself: after a reload the stage is built before the offset to the server is learnt, and the
  // time read then is the PC's own (the clock would open at the PC's lag behind the server).
  watch(deps.serverNow, (now) => {
    startedAt.value ??= now;
  });

  const open = (): boolean =>
    deps.active() && !box.sending.value && box.result.value?.kind !== "passed";

  return {
    masked,
    sending: box.sending,
    verdict: computed(() =>
      submitVerdict(box.sending.value, box.result.value, stage5ReportVerdicts.sent),
    ),
    elapsedMs: computed(() =>
      startedAt.value === null ? 0 : deps.serverNow.value - startedAt.value,
    ),
    holding: readonly(holding),
    toggle(index) {
      if (!open() || !clickable(index)) return;
      const next = new Set(masked.value);
      if (!next.delete(index)) next.add(index);
      masked.value = next;
    },
    submit() {
      if (!open()) return;
      const maskedIndices = [...masked.value].sort((a, b) => a - b);
      box.submit(maskedIndices.join(","), (commandId) =>
        deps.send({ type: "s5.submit-report", maskedIndices }, commandId),
      );
    },
  };
};
