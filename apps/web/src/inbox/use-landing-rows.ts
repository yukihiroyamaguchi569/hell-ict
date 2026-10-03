import { onScopeDispose, shallowRef, watch } from "vue";
import type { Ref } from "vue";

import type { Scheduler } from "../ports.js";
import { landingIds, type InboxDraw } from "./inbox-view.js";

/** How long a landing row keeps its class (mock `.mail.landing`: the 0.55 s `land` animation). */
export const LANDING_MS = 550;

/**
 * The inbox rows shaking now. Which ones land is inbox-view's `landingIds`; each lands for
 * LANDING_MS on a timer rather than until `animationend`, which does not come for an animation
 * that never ran.
 */
export const useLandingRows = (
  draw: () => InboxDraw,
  scheduler: Scheduler,
): Readonly<Ref<ReadonlySet<string>>> => {
  const landing = shallowRef<ReadonlySet<string>>(new Set());
  const cancels = new Set<() => void>();

  const settle = (ids: ReadonlySet<string>): void => {
    landing.value = new Set([...landing.value].filter((id) => !ids.has(id)));
  };

  watch(
    draw,
    (next, previous) => {
      const before = landing.value;
      landing.value = landingIds(before, previous, next);
      const arrived = new Set([...landing.value].filter((id) => !before.has(id)));
      if (arrived.size === 0) return;
      const cancel = scheduler.schedule(() => {
        cancels.delete(cancel);
        settle(arrived);
      }, LANDING_MS);
      cancels.add(cancel);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    for (const cancel of cancels) cancel();
  });

  return landing;
};
