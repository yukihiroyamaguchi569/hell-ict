import { gameInstantSchema, stage3SubmissionSchema } from "@hell-ict/domain";
import type { Stage3FieldId, Stage3Submission, TeamGameViewState } from "@hell-ict/domain";
import { computed, onScopeDispose, reactive, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import { z } from "zod";

import type { GameCommandInput, SendOutcome } from "../../composables/use-game-session.js";
import type { Sfx } from "../../composables/use-sfx.js";
import type { KeyValueStorage, Scheduler } from "../../ports.js";
import { sessionRecord, sessionRecordKey } from "../../session-record.js";
import type { Verdict } from "../../verdict/verdict.js";
import type { KarubeCall } from "../stage-module.js";
import { stage3KarubeCalls } from "./karube-calls.js";
import { stage3Overlay, stage3Result, stage3Verdict, type Stage3Overlay } from "./s3-view.js";

/** How long the screen stays dark after the trap fires, before the dermatologist calls (mock 1400 ms). */
export const BLACKOUT_MS = 1_400;

export interface Stage3Deps {
  readonly state: () => TeamGameViewState | null;
  readonly teamCode: () => string | null;
  readonly send: (command: GameCommandInput) => Promise<SendOutcome>;
  readonly serverNow: Readonly<Ref<number>>;
  readonly storage: KeyValueStorage;
  readonly scheduler: Scheduler;
  readonly sfx: Sfx;
}

export interface Stage3 {
  /** The three fields, kept in sessionStorage `hellVueS3Draft:<code>` as they are typed. */
  readonly draft: Stage3Submission;
  readonly verdict: Readonly<Ref<Verdict | null>>;
  /** The field the last rejection pointed at (drawn in the warning colour). */
  readonly warnField: Readonly<Ref<Stage3FieldId | null>>;
  readonly submitting: Readonly<Ref<boolean>>;
  readonly overlay: ComputedRef<Stage3Overlay>;
  /** 苅部さん's calls that should have rung by now, oldest first (`stage3KarubeCalls`). */
  readonly karubeCalls: ComputedRef<readonly KarubeCall[]>;
  submit(): Promise<void>;
  dismissNotice(): void;
  dismissScold(): void;
  /** The penalty has been paid: the answer to the submission before it is no longer news. */
  clearVerdict(): void;
}

const EMPTY: Stage3Submission = { ppe: "", release: "", clean: "" };

export const useStage3 = (deps: Stage3Deps): Stage3 => {
  const code = deps.teamCode() ?? "";
  const draftRecord = sessionRecord(
    deps.storage,
    sessionRecordKey("S3Draft", code),
    stage3SubmissionSchema,
  );
  const noticeRecord = sessionRecord(
    deps.storage,
    sessionRecordKey("S3Notice", code),
    z.literal(true),
  );

  /** The stay (its entry time) in which a short field was sent back before the trap. */
  const rejectedRecord = sessionRecord(
    deps.storage,
    sessionRecordKey("S3Rejected", code),
    gameInstantSchema,
  );

  const draft = reactive<Stage3Submission>({ ...EMPTY, ...draftRecord.read() });
  watch(draft, () => {
    draftRecord.write({ ...draft });
  });

  const verdict = ref<Verdict | null>(null);
  const warnField = ref<Stage3FieldId | null>(null);
  const submitting = ref(false);
  const noticeSeen = ref(noticeRecord.read() === true);
  const trapScene = ref<"blackout" | "scold" | null>(null);
  const rejectedIn = ref<string | null>(rejectedRecord.read());

  /** Only before the trap: after it, a rejection no longer brings him (mock s3KarubeAutoNudged). */
  const noteRejection = (): void => {
    const state = deps.state();
    const entered = state?.enteredAt.s3;
    if (state?.game.penalties.s3 !== "none" || entered === undefined) return;
    rejectedIn.value = entered;
    rejectedRecord.write(entered);
  };

  const overlay = computed(() => {
    const state = deps.state();
    return state === null
      ? null
      : stage3Overlay({
          state,
          serverNow: deps.serverNow.value,
          noticeSeen: noticeSeen.value,
          trapScene: trapScene.value,
          submitting: submitting.value,
        });
  });

  let cancelBlackout: () => void = () => undefined;
  onScopeDispose(() => {
    cancelBlackout();
  });
  const fireTrap = (): void => {
    trapScene.value = "blackout";
    deps.sfx.play("don-1");
    cancelBlackout = deps.scheduler.schedule(() => {
      trapScene.value = "scold";
    }, BLACKOUT_MS);
  };

  const submit = async (): Promise<void> => {
    if (submitting.value) return;
    submitting.value = true;
    warnField.value = null;
    verdict.value = { kind: "checking" };
    const result = stage3Result(await deps.send({ type: "s3.submit", submission: { ...draft } }));
    verdict.value = stage3Verdict(result);
    if (result.kind === "reject") {
      warnField.value = result.field;
      deps.sfx.play("cancel");
      noteRejection();
    }
    if (result.kind === "trap-first") fireTrap();
    submitting.value = false;
  };

  return {
    draft,
    verdict,
    warnField,
    submitting,
    overlay,
    karubeCalls: computed(() => {
      const state = deps.state();
      return state === null ? [] : stage3KarubeCalls(state, rejectedIn.value);
    }),
    submit,
    dismissNotice() {
      noticeSeen.value = true;
      noticeRecord.write(true);
    },
    dismissScold() {
      trapScene.value = null;
    },
    clearVerdict() {
      verdict.value = null;
      warnField.value = null;
    },
  };
};
