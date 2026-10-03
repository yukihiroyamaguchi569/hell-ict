import { stage4DirectorPages } from "@hell-ict/content";
import { computed, onScopeDispose, readonly, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

import { useAtServerTime } from "../../composables/use-at-server-time.js";
import type { SendOutcome } from "../../composables/use-game-session.js";
import { sessionRecord, sessionRecordKey, type SessionRecord } from "../../session-record.js";
import type { Verdict } from "../../verdict/verdict.js";
import { submitResult, type SubmitResult } from "../common/submit-result.js";
import type { StageContext } from "../stage-module.js";
import {
  actionSentBackLine,
  DIRECTOR_DELAY_MS,
  stage4RecordSchema,
  submitVerdict,
  summaryAcceptedText,
  summarySentBackLine,
  TALK_DELAY_MS,
  type Stage4Record,
} from "./s4-view.js";
import { useDirectorWindow, type DirectorWindow } from "./use-director-window.js";

/** One submission box: one send at a time, and a resend of the same text keeps its commandId. */
interface Submission {
  readonly sending: Readonly<Ref<boolean>>;
  readonly result: Readonly<Ref<SubmitResult | null>>;
  submit(text: string): void;
}

const useSubmission = (deps: {
  readonly send: (text: string, commandId: string) => Promise<SendOutcome>;
  readonly newCommandId: () => string;
  readonly sentBackLine: (judgement: unknown) => string | null;
  readonly onSentBack: () => void;
}): Submission => {
  const sending = ref(false);
  const result = shallowRef<SubmitResult | null>(null);
  /** Kept while the last send may have arrived unanswered: the same text goes under the same id. */
  let pending: { readonly text: string; readonly commandId: string } | null = null;
  let active = true;
  onScopeDispose(() => {
    active = false;
  });

  return {
    sending: readonly(sending),
    result,
    submit(text) {
      if (sending.value) return;
      sending.value = true;
      result.value = null;
      const commandId = pending?.text === text ? pending.commandId : deps.newCommandId();
      pending = { text, commandId };
      void deps.send(text, commandId).then((outcome) => {
        if (!active) return;
        const next = submitResult(outcome, deps.sentBackLine);
        if (next.kind !== "retry") pending = null;
        sending.value = false;
        result.value = next;
        if (next.kind === "sent-back") deps.onSentBack();
      });
    },
  };
};

export interface Stage4 {
  readonly director: DirectorWindow;
  readonly summary: Ref<string>;
  readonly summaryAccepted: ComputedRef<boolean>;
  readonly summarySending: Readonly<Ref<boolean>>;
  readonly summaryWarn: ComputedRef<boolean>;
  readonly summaryVerdict: ComputedRef<Verdict | null>;
  readonly submitSummary: () => void;
  /** The director's question and the action box under the summary. */
  readonly talkShown: Readonly<Ref<boolean>>;
  readonly action: Ref<string>;
  readonly actionSending: Readonly<Ref<boolean>>;
  readonly actionWarn: ComputedRef<boolean>;
  readonly actionVerdict: ComputedRef<Verdict | null>;
  /** The stage is cleared: the action box goes, the clear takes over. */
  readonly cleared: ComputedRef<boolean>;
  readonly submitAction: () => void;
}

export const useStage4 = (context: StageContext): Stage4 => {
  const { session, scheduler, sfx } = context;
  const state = computed(() => session.view.value?.state ?? null);
  const enteredAt = computed(() => state.value?.enteredAt.s4 ?? null);
  const summaryAccepted = computed(() => state.value?.s4.summaryAccepted ?? false);
  const cleared = computed(() => state.value?.game.clearedAt.s4 !== undefined);

  const summary = ref("");
  const directorClosed = ref(false);
  let record: SessionRecord<Stage4Record> | null = null;

  watch(
    [session.teamCode, enteredAt],
    ([code, entered]) => {
      record =
        code === null || entered === null
          ? null
          : sessionRecord(context.sessionStorage, sessionRecordKey("S4", code), stage4RecordSchema);
      const kept = record?.read() ?? null;
      const same = kept !== null && kept.enteredAt === entered;
      summary.value = same ? kept.summary : "";
      directorClosed.value = same && kept.directorClosed;
    },
    { immediate: true },
  );
  watch([summary, directorClosed], ([text, closed]) => {
    if (enteredAt.value === null) return;
    record?.write({ enteredAt: enteredAt.value, summary: text, directorClosed: closed });
  });

  const director = useDirectorWindow({
    scheduler,
    pageCount: stage4DirectorPages.length,
    onClose: () => {
      directorClosed.value = true;
    },
  });
  // After the red band, once per stay; never again once read, nor after the summary went in.
  useAtServerTime(
    context.serverNow,
    () =>
      enteredAt.value === null || directorClosed.value || summaryAccepted.value || cleared.value
        ? null
        : {
            key: `s4-director:${enteredAt.value}`,
            at: Date.parse(enteredAt.value) + DIRECTOR_DELAY_MS,
          },
    () => {
      director.open();
    },
  );

  const newCommandId = (): string => session.newCommandId();
  const warnWithSound = (): void => {
    sfx.play("cancel");
  };
  const summaryBox = useSubmission({
    send: (text, id) => session.send({ type: "s4.submit-summary", text }, id),
    newCommandId,
    sentBackLine: summarySentBackLine,
    onSentBack: warnWithSound,
  });
  const actionBox = useSubmission({
    send: (text, id) => session.send({ type: "s4.submit-action", text }, id),
    newCommandId,
    sentBackLine: actionSentBackLine,
    onSentBack: warnWithSound,
  });

  // A reload after the summary went in brings the talk back at once; a fresh one waits a beat.
  const talkShown = ref(summaryAccepted.value);
  let cancelTalk: () => void = () => undefined;
  watch(summaryAccepted, (accepted) => {
    cancelTalk();
    if (!accepted) {
      talkShown.value = false;
      return;
    }
    cancelTalk = scheduler.schedule(() => {
      talkShown.value = true;
    }, TALK_DELAY_MS);
  });
  onScopeDispose(() => {
    cancelTalk();
  });

  const action = ref("");
  const isSentBack = (box: Submission): boolean => box.result.value?.kind === "sent-back";

  return {
    director,
    summary,
    summaryAccepted,
    summarySending: summaryBox.sending,
    summaryWarn: computed(() => !summaryAccepted.value && isSentBack(summaryBox)),
    summaryVerdict: computed(() =>
      submitVerdict(
        summaryBox.sending.value,
        summaryBox.result.value,
        summaryAcceptedText(summaryAccepted.value),
      ),
    ),
    submitSummary: () => {
      if (summaryAccepted.value || cleared.value) return;
      summaryBox.submit(summary.value);
    },
    talkShown: readonly(talkShown),
    action,
    actionSending: actionBox.sending,
    actionWarn: computed(() => isSentBack(actionBox)),
    actionVerdict: computed(() =>
      submitVerdict(actionBox.sending.value, actionBox.result.value, null),
    ),
    cleared,
    submitAction: () => {
      // The director asks for an action only after the summary (the server refuses it too).
      if (!summaryAccepted.value || cleared.value) return;
      actionBox.submit(action.value);
    },
  };
};
