import { onScopeDispose, readonly, ref, shallowRef } from "vue";
import type { Ref } from "vue";

import type { SendOutcome } from "../../composables/use-game-session.js";
import type { SubmitResult } from "./s5-view.js";

/** One submission box of Stage 5 (the list, the report). */
export interface Submission {
  readonly sending: Readonly<Ref<boolean>>;
  readonly result: Readonly<Ref<SubmitResult | null>>;
  /**
   * Sends unless a send is on its way. `key` names what is sent: after a `retry`, the same key
   * goes again under the same commandId, so the server applies it once.
   */
  submit(key: string, send: (commandId: string) => Promise<SendOutcome>): void;
  /** Forgets the answer and the pending id (a new penalty). */
  reset(): void;
}

export const useSubmission = (deps: {
  readonly newCommandId: () => string;
  readonly read: (outcome: SendOutcome) => SubmitResult;
  readonly onResult: (result: SubmitResult) => void;
}): Submission => {
  const sending = ref(false);
  const result = shallowRef<SubmitResult | null>(null);
  let pending: { readonly key: string; readonly commandId: string } | null = null;
  let generation = 0;
  onScopeDispose(() => {
    generation += 1;
  });

  return {
    sending: readonly(sending),
    result,
    submit(key, send) {
      if (sending.value) return;
      sending.value = true;
      result.value = null;
      const commandId = pending?.key === key ? pending.commandId : deps.newCommandId();
      pending = { key, commandId };
      const mine = generation;
      void send(commandId).then((outcome) => {
        if (mine !== generation) return;
        const next = deps.read(outcome);
        if (next.kind !== "retry") pending = null;
        sending.value = false;
        result.value = next;
        deps.onResult(next);
      });
    },
    reset() {
      generation += 1;
      sending.value = false;
      result.value = null;
      pending = null;
    },
  };
};
