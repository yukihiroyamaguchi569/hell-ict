import { getCurrentScope, onScopeDispose, readonly, ref } from "vue";
import type { Ref } from "vue";

import type { Scheduler } from "../ports.js";

/**
 * The least time the opening stays up (Issue #31): with the assets cached it would otherwise
 * vanish before anyone sees the hospital.
 */
export const OPENING_MIN_MS = 3_000;

/** Turns true once `OPENING_MIN_MS` has passed since the call. Never turns back to false. */
export const useOpeningMinimum = (scheduler: Scheduler): Readonly<Ref<boolean>> => {
  const elapsed = ref(false);
  const cancel = scheduler.schedule(() => {
    elapsed.value = true;
  }, OPENING_MIN_MS);
  if (getCurrentScope() !== undefined) onScopeDispose(cancel);
  return readonly(elapsed);
};
