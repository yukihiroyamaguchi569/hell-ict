import { computed, onScopeDispose, readonly, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import type { z } from "zod";

import { activityNext, type ActivityApi, type ActivityEntry } from "../../api/activity-api.js";
import { sessionRecord, sessionRecordKey, type SessionRecord } from "../../session-record.js";
import type { StageContext } from "../stage-module.js";
import * as view from "./final-view.js";
import type { FinalPhase, FinalRecord, PendingLine } from "./final-view.js";
import { CONFETTI_CLEAR_MS } from "./goal-view.js";

export interface Final {
  readonly phase: Readonly<Ref<FinalPhase>>;
  /** The line the team left, or `null` before it is written. */
  readonly line: Readonly<Ref<string | null>>;
  readonly draft: Ref<string>;
  /** Why the line was refused (「一言を入力してください。」), "" otherwise. */
  readonly note: Readonly<Ref<string>>;
  readonly pieceOpen: ComputedRef<boolean>;
  /** The goal's confetti is falling: each time the goal comes up, for CONFETTI_CLEAR_MS. */
  readonly confetti: Readonly<Ref<boolean>>;
  /** The team's name on the goal's title (the name, a wide space, 「ゴール」). */
  readonly goalName: ComputedRef<string>;
  readonly address: ComputedRef<string>;
  readonly quote: ComputedRef<string>;
  pressGoalNext(): void;
  pressEpilogueNext(): void;
  writeLine(): void;
  pressRelayBackdrop(): void;
  pressRelayNext(): void;
  /** ［最初に戻る］: leaves the certificate; nothing the team did is forgotten. */
  restart(): void;
  /** Going on again from where ［最初に戻る］ left: the certificate comes back. */
  resume(): void;
}

/** One timer at a time; a new one cancels the last, and leaving the stage cancels it. */
const useTimer = (context: StageContext): ((task: () => void, delayMs: number) => void) => {
  let cancel: () => void = () => undefined;
  onScopeDispose(() => {
    cancel();
  });
  return (task, delayMs) => {
    cancel();
    cancel = context.scheduler.schedule(task, delayMs);
  };
};

/**
 * Sends the line to the activity log, and again under the same commandId while the answer may
 * still change (`activityNext`). `onDone` runs once it is kept or refused for good; a reset team
 * turns the tab stale. The game goes on whatever the answer: the log is for the debriefing.
 */
const useLineLog = (
  context: StageContext,
  activity: ActivityApi,
  onDone: () => void,
): ((line: string, pending: PendingLine) => void) => {
  const { session } = context;
  const later = useTimer(context);
  let active = true;
  onScopeDispose(() => {
    active = false;
  });
  return (line, pending) => {
    const code = session.teamCode.value;
    const generation = session.generation.value;
    if (code === null || generation === null) return;
    const entry: ActivityEntry = {
      ...pending,
      kind: "submit.final",
      view: "final",
      text: line,
      generation,
    };
    const send = (attempt: number): void => {
      void activity.record(code, entry).then((result) => {
        if (!active) return;
        const next = activityNext(result, attempt);
        if (next.kind === "done") onDone();
        if (next.kind === "stale") session.markStale();
        if (next.kind === "retry") {
          later(() => {
            send(attempt + 1);
          }, next.delayMs);
        }
      });
    };
    send(0);
  };
};

/** `hellVueFinalIntro:<code>` and `hellVueFinal:<code>` of the team on screen (`null` before one). */
const finalRecords = (context: StageContext) => {
  const of =
    <T>(name: string, schema: z.ZodType<T>) =>
    (): SessionRecord<T> | null => {
      const code = context.session.teamCode.value;
      return code === null
        ? null
        : sessionRecord(context.sessionStorage, sessionRecordKey(name, code), schema);
    };
  return {
    intro: of("FinalIntro", view.finalIntroRecordSchema),
    final: of("Final", view.finalRecordSchema),
  };
};

/** A value kept for another `enteredAt` is a run before the game master's reset: not read. */
const readFor = <T extends { readonly enteredAt: string }>(
  record: SessionRecord<T> | null,
  enteredAt: string,
): T | null => {
  const kept = record === null ? null : record.read();
  return kept !== null && kept.enteredAt === enteredAt ? kept : null;
};

export const useFinal = (context: StageContext, activity: ActivityApi): Final => {
  const { session } = context;
  const enteredAt = computed(() => session.view.value?.state.enteredAt.final ?? null);
  const phase = shallowRef<FinalPhase>({ kind: "goal" });
  const line = ref<string | null>(null);
  const ended = ref(false);
  const draft = ref("");
  const note = ref("");
  const pending = shallowRef<PendingLine | null>(null);
  const later = useTimer(context);
  const confetti = ref(false);
  const confettiLater = useTimer(context);
  const records = finalRecords(context);
  let epilogueArmed = false;

  /** Moves the scene by `step`; a step that does not apply to the scene leaves it as it is. */
  const move = (step: (current: FinalPhase) => FinalPhase) => (): void => {
    phase.value = step(phase.value);
  };
  const saveRecord = (): void => {
    const entered = enteredAt.value;
    if (entered === null) return;
    const kept = { line: line.value, ended: ended.value, pending: pending.value };
    records.final()?.write({ enteredAt: entered, ...kept });
  };
  const logLine = useLineLog(context, activity, () => {
    pending.value = null;
    saveRecord();
  });
  const restore = (kept: FinalRecord | null): void => {
    line.value = kept?.line ?? null;
    ended.value = kept?.ended ?? false;
    pending.value = kept?.pending ?? null;
  };
  const relayLater = (delayMs: number): void => {
    later(() => {
      phase.value = view.startRelay(phase.value, line.value);
    }, delayMs);
  };

  watch(
    enteredAt,
    (entered) => {
      if (entered === null) return;
      const kept = readFor(records.final(), entered);
      restore(kept);
      phase.value = view.entryPhase(readFor(records.intro(), entered) !== null, kept);
      // Written before a reload but not known to be kept: the same entry goes again.
      if (line.value !== null && pending.value !== null) logLine(line.value, pending.value);
      // Written but the certificate not reached: the relay comes again over the complete board.
      if (phase.value.kind === "board" && line.value !== null) relayLater(view.RELAY_ON_RETURN_MS);
    },
    { immediate: true },
  );

  // The epilogue ignores presses for a moment; the tiles light one by one while the board is dark.
  watch(
    phase,
    (current) => {
      if (current.kind === "epilogue") {
        epilogueArmed = false;
        later(() => {
          epilogueArmed = true;
        }, view.EPILOGUE_GRACE_MS);
      }
      if (view.lightNextTile(current) !== current) {
        later(move(view.lightNextTile), view.BOARD_LIGHT_MS);
      }
    },
    { immediate: true },
  );

  // One burst each time the goal comes up (a reload before ［振り返りへ］ included), taken away
  // on the stage's own timer so it goes even when the animation never ends.
  watch(
    () => phase.value.kind === "goal",
    (onGoal) => {
      confetti.value = onGoal;
      if (!onGoal) return;
      confettiLater(() => {
        confetti.value = false;
      }, CONFETTI_CLEAR_MS);
    },
    { immediate: true },
  );

  return {
    phase: readonly(phase),
    confetti: readonly(confetti),
    line: readonly(line),
    draft,
    note: readonly(note),
    pieceOpen: computed(() => view.pieceOpen(phase.value, line.value)),
    goalName: computed(() => view.goalTeamName(context.teamName.value)),
    address: computed(() => view.handoverAddress(context.teamName.value)),
    quote: computed(() => view.handoverQuote(line.value)),
    pressGoalNext: move(view.afterGoal),
    pressEpilogueNext() {
      const entered = enteredAt.value;
      if (phase.value.kind !== "epilogue" || !epilogueArmed || entered === null) return;
      records.intro()?.write({ enteredAt: entered });
      move(view.afterEpilogue)();
    },
    writeLine() {
      if (!view.pieceOpen(phase.value, line.value)) return;
      const checked = view.checkLine(draft.value);
      note.value = checked.kind === "refused" ? checked.note : "";
      if (checked.kind === "refused") return;
      line.value = checked.line;
      const sent = {
        commandId: session.newCommandId(),
        clientAt: new Date(context.serverNow.value).toISOString(),
      };
      pending.value = sent;
      saveRecord();
      logLine(checked.line, sent);
      relayLater(view.RELAY_AFTER_LINE_MS);
    },
    pressRelayBackdrop: move(view.relayBackdrop),
    pressRelayNext() {
      move(view.relayNext)();
      if (phase.value.kind !== "handover") return;
      ended.value = true;
      saveRecord();
    },
    restart: move(view.restart),
    resume: move(view.resume),
  };
};
