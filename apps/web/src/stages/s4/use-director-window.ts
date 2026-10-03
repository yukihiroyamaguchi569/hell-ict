import { onScopeDispose, readonly, ref } from "vue";
import type { Ref } from "vue";

import type { Scheduler } from "../../ports.js";
import { DIRECTOR_PAGE_GRACE_MS } from "./s4-view.js";

export interface DirectorWindow {
  readonly visible: Readonly<Ref<boolean>>;
  readonly page: Readonly<Ref<number>>;
  open(): void;
  /** ［次へ］ / ［了解しました］: the next page, or closing after the last. */
  press(): void;
}

/**
 * The director's window of `pageCount` pages (mock #ov-s4-director). Each page ignores presses
 * for DIRECTOR_PAGE_GRACE_MS after it appears: a double click on ［次へ］ must not close the last
 * page, which gives the task, unread. `onClose` runs once the last page is closed.
 */
export const useDirectorWindow = (deps: {
  readonly scheduler: Scheduler;
  readonly pageCount: number;
  readonly onClose: () => void;
}): DirectorWindow => {
  const visible = ref(false);
  const page = ref(0);
  let armed = false;
  let cancelArm: () => void = () => undefined;

  const show = (next: number): void => {
    page.value = next;
    armed = false;
    cancelArm();
    cancelArm = deps.scheduler.schedule(() => {
      armed = true;
    }, DIRECTOR_PAGE_GRACE_MS);
  };
  onScopeDispose(() => {
    cancelArm();
  });

  return {
    visible: readonly(visible),
    page: readonly(page),
    open() {
      if (visible.value) return;
      visible.value = true;
      show(0);
    },
    press() {
      if (!visible.value || !armed) return;
      if (page.value < deps.pageCount - 1) {
        show(page.value + 1);
        return;
      }
      visible.value = false;
      deps.onClose();
    },
  };
};
