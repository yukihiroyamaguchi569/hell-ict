import type { ViewerId } from "@hell-ict/content";
import { computed, readonly, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";

import type { MailSelection, StageInstance } from "../stages/stage-module.js";
import { inboxAction, inboxView, type InboxView } from "./inbox-view.js";
import type { MailRead } from "./use-mail-read.js";

/** The mail the centre reads. One for the screen; `useStageInbox` empties it between stages. */
export const useMailSelection = (): MailSelection => {
  const openId = ref<string | null>(null);
  return {
    openId: readonly(openId),
    open(id) {
      openId.value = id;
    },
    close() {
      openId.value = null;
    },
  };
};

export interface StageInboxDeps {
  /** The stage on screen (`StageFrame.instance`). */
  readonly instance: Readonly<Ref<StageInstance | null>>;
  readonly mail: MailSelection;
  readonly mailRead: MailRead;
  readonly openViewer: (doc: ViewerId) => void;
}

export interface StageInboxPane {
  /** `null` while the stage on screen has no inbox (the pane stays empty). */
  readonly view: ComputedRef<InboxView | null>;
  select(id: string): void;
}

/**
 * The inbox pane of the stage on screen: its rows with what has been read, and what a press
 * does. A stage change closes the mail the centre had open.
 */
export const useStageInbox = (deps: StageInboxDeps): StageInboxPane => {
  const inbox = computed(() => deps.instance.value?.inbox ?? null);

  watch(deps.instance, () => {
    deps.mail.close();
  });

  return {
    view: computed(() =>
      inbox.value === null
        ? null
        : inboxView(inbox.value.rows.value, deps.mailRead.readIds.value, deps.mail.openId.value),
    ),
    select(id) {
      const current = inbox.value;
      if (current === null) return;
      const action = inboxAction(current.rows.value, id);
      if (action === null) return;
      deps.mailRead.markRead(id);
      if (action.kind === "center") deps.mail.open(id);
      else if (action.kind === "viewer") deps.openViewer(action.doc);
      else current.onOpen?.(id);
    },
  };
};
