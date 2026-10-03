import {
  chatSendNotices,
  stage6CopyReject,
  stage6CopyRejectDelayMs,
  stage6GenerateBusy,
  stage6GenerateMs,
} from "@hell-ict/content";
import {
  CHAT_MESSAGE_MAX_CHARS,
  detectPii,
  isS6PromptCopiedFromMail,
  redactPii,
} from "@hell-ict/domain";
import { computed, onScopeDispose, readonly, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import type { z } from "zod";

import type { ChatReply } from "../../chat/pane-items.js";
import type { ScriptedChat } from "../../chat/use-scripted-chat.js";
import { sessionRecord, sessionRecordKey, type SessionRecord } from "../../session-record.js";
import type { Verdict } from "../../verdict/verdict.js";
import type { SubmitResult } from "../common/submit-result.js";
import type { KarubeCall, StageContext } from "../stage-module.js";
import {
  appliedSends,
  stage6GenerateResult,
  stage6KarubeCalls,
  stage6UnsettledSchema,
  keptUnsettled,
  UNSETTLED_MAX,
  stage6PickSchema,
  stage6Selected,
  stage6SubmitResult,
  stage6TaskSchema,
  stage6Turns,
  stage6Verdict,
  type Stage6Local,
  type Stage6Pick,
  type Stage6Selected,
  type UnsettledSend,
} from "./s6-view.js";

export interface Stage6 {
  /** The right pane's conversation (`StageInstance.chat`). */
  readonly chat: ScriptedChat;
  /** 事務長's call on entering, until 了解しました (not again after a reload). */
  readonly taskOpen: ComputedRef<boolean>;
  readonly closeTask: () => void;
  /** The candidate in the submission box (`null`: 未選択, ［提出する］ is off). */
  readonly selected: ComputedRef<Stage6Selected | null>;
  readonly submitting: Readonly<Ref<boolean>>;
  /** Sent back: the box turns to the warning colour. */
  readonly warn: ComputedRef<boolean>;
  readonly verdict: ComputedRef<Verdict | null>;
  readonly cleared: ComputedRef<boolean>;
  readonly submit: () => void;
  readonly karube: ComputedRef<readonly KarubeCall[]>;
}

interface Generation {
  readonly id: number;
  readonly text: string;
  readonly commandId: string;
  /** The candidate it made (`null` while the answer is to come). */
  readonly made: number | null;
  /** The shortest wait is over. */
  readonly waited: boolean;
  /** Not known to have arrived, and not found in the state read again. */
  readonly failed: boolean;
}

/** A generation not known to have arrived, with 「届かなかった」 once it has been said. */
interface Unsettled extends UnsettledSend {
  /** The text as the server keeps it (personal data blacked out): what its log would hold. */
  readonly shown: string;
  readonly noteId: number | null;
  /**
   * Its answer is known lost (and the state read again did not show it). Otherwise it waits for
   * its answer: sent from this screen, or kept from before a reload and sent again.
   */
  readonly lost: boolean;
}

/** A record that is only valid for this stay in the stage (`enteredAt`). */
const useStayRecord = <T extends { readonly enteredAt: string }>(
  context: StageContext,
  name: string,
  schema: z.ZodType<T>,
  enteredAt: Readonly<Ref<string | null>>,
): { readonly value: Readonly<Ref<T | null>>; write(value: T): void; clear(): void } => {
  // Boxed: a shallowRef of a bare type parameter does not narrow to `ShallowRef<T | null>`.
  const box = shallowRef<{ readonly kept: T | null }>({ kept: null });
  let record: SessionRecord<T> | null = null;
  watch(
    [context.session.teamCode, enteredAt],
    ([code, entered]) => {
      record =
        code === null
          ? null
          : sessionRecord(context.sessionStorage, sessionRecordKey(name, code), schema);
      const kept = record?.read() ?? null;
      box.value = { kept: kept !== null && kept.enteredAt === entered ? kept : null };
    },
    { immediate: true },
  );
  return {
    value: computed(() => box.value.kept),
    write(next) {
      box.value = { kept: next };
      record?.write(next);
    },
    clear() {
      box.value = { kept: null };
      record?.clear();
    },
  };
};

export const useStage6 = (context: StageContext): Stage6 => {
  const { session, scheduler } = context;
  const state = computed(() => session.view.value?.state ?? null);
  const enteredAt = computed(() => state.value?.enteredAt.s6 ?? null);
  const s6 = computed(() => state.value?.s6 ?? { promptLog: [], candidates: [] });
  const cleared = computed(() => state.value?.game.clearedAt.s6 !== undefined);

  const cancels: (() => void)[] = [];
  let active = true;
  onScopeDispose(() => {
    active = false;
    for (const cancel of cancels) cancel();
  });
  const later = (task: () => void, delayMs: number): void => {
    cancels.push(scheduler.schedule(task, delayMs));
  };

  // ---- The conversation ----
  const hideFrom = ref<number | null>(null);
  const generations = shallowRef<readonly Generation[]>([]);
  const notes = shallowRef<Stage6Local["notes"]>([]);
  let nextNoteId = -1;
  /** The candidates this screen's generations are known to have made. */
  const claimed = new Set<number>();

  /** Where the next turn stands: after the candidates shown and the generations waiting. */
  const position = (): number =>
    (hideFrom.value ?? s6.value.candidates.length) + generations.value.length;

  const note = (text: string, reply: ChatReply | null, after = position()): number => {
    const id = nextNoteId--;
    notes.value = [...notes.value, { id, text, reply, after }];
    return id;
  };
  const answerNote = (id: number, reply: ChatReply): void => {
    notes.value = notes.value.map((item) => (item.id === id ? { ...item, reply } : item));
  };
  const sendBackCopy = (text: string, after?: number): void => {
    const id = note(text, null, after);
    later(() => {
      answerNote(id, { text: stage6CopyReject });
    }, stage6CopyRejectDelayMs);
  };

  // ---- Generations not known to have arrived ----
  // Kept per text: sending the same text again goes under its commandId (a landed one comes back
  // `duplicate`). Whenever a state shows one landed, it is dropped with its 「届かなかった」.
  const record = useStayRecord(context, "S6Generate", stage6UnsettledSchema, enteredAt);
  const unsettled = shallowRef<readonly Unsettled[]>(
    (record.value.value?.entries ?? []).map((entry) => ({
      ...entry,
      shown: redactPii(entry.text),
      noteId: null,
      lost: false,
    })),
  );
  const saveUnsettled = (next: readonly Unsettled[]): void => {
    unsettled.value = keptUnsettled(next);
    const entries = unsettled.value
      .filter((send) => detectPii(send.text) === null)
      .map(({ text, commandId, sentAtCount }) => ({ text, commandId, sentAtCount }));
    const entered = enteredAt.value;
    if (entered === null || entries.length === 0) record.clear();
    else record.write({ enteredAt: entered, entries });
  };
  /** Drops a settled send, and its 「届かなかった」 when `unsay` (it did land after all). */
  const settle = (commandId: string, unsay: boolean): void => {
    const send = unsettled.value.find((item) => item.commandId === commandId);
    if (send === undefined) return;
    if (unsay && send.noteId !== null) {
      notes.value = notes.value.filter((item) => item.id !== send.noteId);
    }
    saveUnsettled(unsettled.value.filter((item) => item !== send));
  };
  const markLost = (commandId: string, lost: boolean): void => {
    saveUnsettled(
      unsettled.value.map((send) => (send.commandId === commandId ? { ...send, lost } : send)),
    );
  };
  /** Generations waiting for their answer: past UNSETTLED_MAX, no new one is sent. */
  const waitingCount = (): number => unsettled.value.filter((send) => !send.lost).length;
  const sayLost = (generation: Generation, after: number): void => {
    const noteId = note(generation.text, { text: chatSendNotices.unavailable }, after);
    unsettled.value = unsettled.value.map((send) =>
      send.commandId === generation.commandId ? { ...send, noteId } : send,
    );
  };

  /**
   * Settles the generations that have waited and have an outcome, in the order they were sent: a
   * made one shows its candidate, a failed one leaves 「届かなかった」 where it waited.
   */
  const reveal = (): void => {
    let queue = generations.value;
    let from = hideFrom.value ?? 0;
    for (
      let first = queue[0];
      first?.waited === true && (first.made !== null || first.failed);
      first = queue[0]
    ) {
      if (first.made === null) sayLost(first, from);
      else from = Math.max(from, first.made + 1);
      queue = queue.slice(1);
    }
    generations.value = queue;
    hideFrom.value = queue.length === 0 ? null : from;
  };
  const update = (id: number, change: Partial<Generation> | null): void => {
    generations.value = generations.value.flatMap((generation) =>
      generation.id !== id ? [generation] : change === null ? [] : [{ ...generation, ...change }],
    );
    reveal();
  };

  /**
   * The sends of this screen still waiting for their answer: kept (and saved) from before they
   * leave, but their own answer, not the state, says where they landed.
   */
  const inFlight = new Set<string>();

  /** Settles the unsettled sends the state on screen shows landed. */
  const reconcile = (): void => {
    const idle = unsettled.value.filter((send) => !inFlight.has(send.commandId));
    const landed = new Map(
      appliedSends(s6.value.promptLog, idle, claimed).map(
        ([send, index]) => [send.commandId, index] as const,
      ),
    );
    if (landed.size === 0) return;
    for (const [commandId, index] of landed) {
      claimed.add(index);
      settle(commandId, true);
    }
    generations.value = generations.value.map((generation) => {
      const made = landed.get(generation.commandId);
      return made === undefined ? generation : { ...generation, made, failed: false };
    });
    reveal();
  };
  /**
   * Generations of this screen waiting for their answer. A state that comes with one of them may
   * already hold what it made, still unclaimed: it is looked at once they have all answered.
   */
  let answersDue = 0;
  watch(
    () => s6.value.promptLog,
    () => {
      if (answersDue === 0) reconcile();
    },
    { immediate: true },
  );

  /**
   * The send `prompt` goes under: a kept one of the same text whose answer was lost (a retry), else
   * a new one. Either is kept as waiting before it leaves, so that a reload before its answer sends
   * it again under its id. A send of the same text still waiting is another generation.
   */
  const sendFor = (prompt: string, shown: string): Unsettled => {
    const retry = unsettled.value.find((send) => send.text === prompt && send.lost);
    if (retry !== undefined) {
      markLost(retry.commandId, false);
      return retry;
    }
    const send = {
      text: prompt,
      shown,
      commandId: session.newCommandId(),
      sentAtCount: s6.value.promptLog.length,
      noteId: null,
      lost: false,
    };
    saveUnsettled([...unsettled.value, send]);
    return send;
  };

  const generate = ({ text: prompt, shown, commandId }: Unsettled): void => {
    inFlight.add(commandId);
    // The candidate index it is expected to become: its turn keeps the id once it is drawn.
    const id = (generations.value.at(-1)?.id ?? s6.value.candidates.length - 1) + 1;
    hideFrom.value ??= s6.value.candidates.length;
    const generation = { id, text: shown, commandId, made: null, waited: false, failed: false };
    generations.value = [...generations.value, generation];
    later(() => {
      update(id, { waited: true });
    }, stage6GenerateMs);
    answersDue++;
    void session.send({ type: "s6.generate", prompt }, commandId).then((outcome) => {
      answersDue--;
      inFlight.delete(commandId);
      if (!active) return;
      const result = stage6GenerateResult(outcome);
      if (result.kind === "made") {
        claimed.add(result.index);
        settle(commandId, true);
        update(id, { made: result.index });
        if (answersDue === 0) reconcile();
        return;
      }
      if (result.kind === "lost") {
        // It may have landed with only the answer lost: the state read again tells. Either way
        // it keeps waiting its 2.5 s.
        void session.refresh().then(() => {
          if (!active) return;
          reconcile();
          if (unsettled.value.some((send) => send.commandId === commandId)) {
            markLost(commandId, true);
            update(id, { failed: true });
          }
        });
        return;
      }
      settle(commandId, false);
      // The note stands where the generation was waiting.
      const at =
        position() - generations.value.length + generations.value.findIndex((g) => g.id === id);
      update(id, null);
      if (result.kind === "copied") sendBackCopy(shown, at);
    });
  };

  // A reload loses the answers still to come. What the state read on entering does not show landed
  // is sent again under its commandId: the server answers `duplicate` with its poster if the first
  // send lands after all, so it is never generated twice.
  if (enteredAt.value !== null && !cleared.value) {
    for (const send of unsettled.value) generate(send);
  }

  // ---- The pick and the submission ----
  const pick = useStayRecord<Stage6Pick>(context, "S6Pick", stage6PickSchema, enteredAt);
  const selected = computed(() => stage6Selected(s6.value, enteredAt.value, pick.value.value));
  // A pick that is not among the candidates (a hand edit, another game) is dropped (decision 9).
  watch(
    [pick.value, s6],
    ([kept, shape]) => {
      if (kept !== null && shape.candidates[kept.index] === undefined) pick.clear();
    },
    { immediate: true },
  );
  const choose = (index: number): void => {
    const entered = enteredAt.value;
    if (entered === null || cleared.value || s6.value.candidates[index] === undefined) return;
    pick.write({ enteredAt: entered, index });
  };

  const chat: ScriptedChat = {
    turns: computed(() =>
      stage6Turns(
        s6.value,
        { hideFrom: hideFrom.value, generating: generations.value, notes: notes.value },
        choose,
      ),
    ),
    send(text) {
      if (enteredAt.value === null || cleared.value) return;
      // What the server keeps (and a reload draws) is the prompt with personal data blacked out.
      const shown = redactPii(text);
      // A copy of the mails is sent back on the screen and never sent (the server refuses it too).
      if (isS6PromptCopiedFromMail(text)) sendBackCopy(shown);
      // The server takes no longer text; a full queue takes no more (the record stays small).
      else if (text.length > CHAT_MESSAGE_MAX_CHARS) note(shown, { text: chatSendNotices.tooLong });
      else if (waitingCount() >= UNSETTLED_MAX) note(shown, { text: stage6GenerateBusy });
      else generate(sendFor(text, shown));
    },
  };

  const submitting = ref(false);
  const result = shallowRef<SubmitResult | null>(null);
  let pending: { readonly index: number; readonly commandId: string } | null = null;
  const submit = (): void => {
    const candidate = selected.value;
    if (candidate === null || submitting.value || cleared.value) return;
    submitting.value = true;
    result.value = null;
    const commandId =
      pending?.index === candidate.index ? pending.commandId : session.newCommandId();
    pending = { index: candidate.index, commandId };
    void session
      .send({ type: "s6.submit", candidateIndex: candidate.index }, commandId)
      .then((outcome) => {
        if (!active) return;
        const next = stage6SubmitResult(outcome);
        if (next.kind !== "retry") pending = null;
        submitting.value = false;
        result.value = next;
        if (next.kind === "sent-back") context.sfx.play("cancel");
      });
  };

  // ---- 事務長's call ----
  const task = useStayRecord(context, "S6Task", stage6TaskSchema, enteredAt);

  return {
    chat,
    taskOpen: computed(
      () => enteredAt.value !== null && task.value.value === null && !cleared.value,
    ),
    closeTask: () => {
      if (enteredAt.value !== null) task.write({ enteredAt: enteredAt.value });
    },
    selected,
    submitting: readonly(submitting),
    warn: computed(() => result.value?.kind === "sent-back"),
    verdict: computed(() => stage6Verdict(submitting.value, result.value, cleared.value)),
    cleared,
    submit,
    karube: computed(() =>
      stage6KarubeCalls(enteredAt.value, context.serverNow.value, cleared.value),
    ),
  };
};
