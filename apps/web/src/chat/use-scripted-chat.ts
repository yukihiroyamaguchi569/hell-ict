import { onScopeDispose, shallowRef, watch } from "vue";
import type { Ref } from "vue";

import type { Scheduler } from "../ports.js";
import type { ChatReply, ScriptedTurn } from "./pane-items.js";

/** What the stage says to a message on the screen (`StageInstance.chatSubmit`). */
export type ChatSubmit = (text: string) => ChatReply;

/** The mock's pause before a scripted answer (`sendAI`'s `later(..., 1100)`). */
export const SCRIPTED_REPLY_DELAY_MS = 1100;

export interface ScriptedChat {
  readonly turns: Readonly<Ref<readonly ScriptedTurn[]>>;
  send(text: string): void;
}

/**
 * The conversation the pane answers on the screen: the stage's own (`StageInstance.chat`, Stage
 * 6), else the scripted one when the stage answers with `chatSubmit` (Stage 2), else `null`: the
 * input sends to the server's AI.
 */
export const paneConversation = (
  own: ScriptedChat | undefined,
  submit: ChatSubmit | undefined,
  scripted: ScriptedChat,
): ScriptedChat | null => own ?? (submit === undefined ? null : scripted);

/**
 * The conversation of a stage that answers on the screen (Stage 2). Memory only: a reload is back
 * to the greeting (user decision 9). The stage is asked when the answer is due, not when the
 * message leaves (mock `sendAI`); a new stage (another `submit`) empties the pane and drops the
 * answers still to come.
 */
export const useScriptedChat = (
  submit: () => ChatSubmit | undefined,
  scheduler: Scheduler,
): ScriptedChat => {
  const turns = shallowRef<readonly ScriptedTurn[]>([]);
  let cancels: (() => void)[] = [];
  let nextId = 0;

  const reset = (): void => {
    for (const cancel of cancels) cancel();
    cancels = [];
    turns.value = [];
  };
  watch(submit, reset);
  onScopeDispose(reset);

  const answer = (id: number, text: string, stage: ChatSubmit): void => {
    const reply = stage(text);
    turns.value = turns.value.map((turn) => (turn.id === id ? { ...turn, reply } : turn));
  };

  return {
    turns,
    send(text) {
      const stage = submit();
      if (stage === undefined) return;
      const id = nextId++;
      turns.value = [...turns.value, { id, text, reply: null }];
      cancels.push(
        scheduler.schedule(() => {
          answer(id, text, stage);
        }, SCRIPTED_REPLY_DELAY_MS),
      );
    },
  };
};
