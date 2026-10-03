import { stage5Cleared } from "@hell-ict/content";
import { gameInstantSchema, stage5DeadlineAt } from "@hell-ict/domain";
import type { TeamGameViewState } from "@hell-ict/domain";
import { computed, onScopeDispose, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

import { useAtServerTime } from "../../composables/use-at-server-time.js";
import type { GameCommandInput, SendOutcome } from "../../composables/use-game-session.js";
import type { Sfx } from "../../composables/use-sfx.js";
import type { KeyValueStorage, Scheduler } from "../../ports.js";
import { sessionRecord, sessionRecordKey } from "../../session-record.js";
import type { Verdict } from "../../verdict/verdict.js";
import {
  stage5CallWanted,
  stage5Overlay,
  stage5Result,
  submitVerdict,
  type Stage5Overlay,
} from "./s5-view.js";
import { useSubmission } from "./use-submission.js";

/** How long the alarm stays before the head of administration calls (mock `wait(1600)`). */
export const ALARM_MS = 1_600;

export interface Stage5Deps {
  readonly state: () => TeamGameViewState | null;
  readonly teamCode: () => string | null;
  readonly send: (command: GameCommandInput, commandId: string) => Promise<SendOutcome>;
  readonly newCommandId: () => string;
  readonly serverNow: Readonly<Ref<number>>;
  readonly storage: KeyValueStorage;
  readonly scheduler: Scheduler;
  readonly sfx: Sfx;
  /** The report's 「送信しました」 is still showing (`RedactPenalty.holding`). */
  readonly penaltyHeld: () => boolean;
}

export interface Stage5 {
  /** The list to submit. Kept in memory only (user decision 4): it may hold patient names. */
  readonly text: Ref<string>;
  readonly submitting: Readonly<Ref<boolean>>;
  readonly verdict: ComputedRef<Verdict | null>;
  /** The last submission was sent back (the box in the warning colour). */
  readonly warn: ComputedRef<boolean>;
  readonly overlay: ComputedRef<Stage5Overlay>;
  submit(): void;
  dismissScold(): void;
  dismissCall(): void;
}

export const useStage5 = (deps: Stage5Deps): Stage5 => {
  const entered = (): string | null => deps.state()?.enteredAt.s5 ?? null;
  const cleared = (): boolean => deps.state()?.game.clearedAt.s5 !== undefined;

  // The trap: seen here only as the server's penalty starting while the stage is on screen.
  const trapScene = ref<"alarm" | "scold" | null>(null);
  let cancelAlarm: () => void = () => undefined;
  onScopeDispose(() => {
    cancelAlarm();
  });
  // Not immediate: a reload into a running penalty goes straight to the report, and a second
  // trap (the penalty already done) changes nothing here: the chat says it was blocked.
  watch(
    () => deps.state()?.game.penalties.s5,
    (now, before) => {
      if (before !== "none" || now !== "in-progress") return;
      trapScene.value = "alarm";
      deps.sfx.play("don-1");
      cancelAlarm = deps.scheduler.schedule(() => {
        trapScene.value = "scold";
      }, ALARM_MS);
    },
  );

  // The deadline's call: once per stay, never again once closed (`hellVueS5Call:<code>`).
  const callRecord = sessionRecord(
    deps.storage,
    sessionRecordKey("S5Call", deps.teamCode() ?? ""),
    gameInstantSchema,
  );
  const callSeenIn = ref<string | null>(callRecord.read());
  const callRangIn = ref<string | null>(null);
  useAtServerTime(
    deps.serverNow,
    () => {
      const stay = entered();
      return stay === null || cleared() || callSeenIn.value === stay
        ? null
        : { key: `s5-call:${stay}`, at: stage5DeadlineAt(stay) };
    },
    () => {
      callRangIn.value = entered();
    },
  );

  const text = ref("");
  const box = useSubmission({
    newCommandId: deps.newCommandId,
    read: stage5Result,
    onResult: (result) => {
      if (result.kind === "sent-back") deps.sfx.play("cancel");
    },
  });

  return {
    text,
    submitting: box.sending,
    verdict: computed(() => submitVerdict(box.sending.value, box.result.value, stage5Cleared)),
    warn: computed(() => !box.sending.value && box.result.value?.kind === "sent-back"),
    overlay: computed(() => {
      const state = deps.state();
      return state === null
        ? null
        : stage5Overlay({
            state,
            trapScene: trapScene.value,
            penaltyHeld: deps.penaltyHeld(),
            callWanted: stage5CallWanted(state, callRangIn.value, callSeenIn.value),
            submitting: box.sending.value,
          });
    }),
    submit() {
      if (cleared()) return;
      const sent = text.value;
      box.submit(sent, (commandId) => deps.send({ type: "s5.submit", text: sent }, commandId));
    },
    dismissScold() {
      trapScene.value = null;
    },
    dismissCall() {
      const stay = entered();
      if (stay === null) return;
      callSeenIn.value = stay;
      callRecord.write(stay);
    },
  };
};
