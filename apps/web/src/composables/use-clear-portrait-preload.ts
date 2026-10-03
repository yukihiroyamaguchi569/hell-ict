import type { GameStageId } from "@hell-ict/domain";
import { onScopeDispose, watch } from "vue";

import { clearPortraitSrcs } from "../overlays/clear-sheets.js";
import type { ImagePreloader, ResumeSignal } from "../ports.js";

export interface ClearPortraitPreloadDeps {
  /** The team's current stage, `null` before the team is in. */
  readonly stage: () => GameStageId | null;
  readonly preloader: ImagePreloader;
  /**
   * Asks again when the tab comes back or the network returns: a preload that failed while
   * offline is not retried by itself. Asking for an image already cached costs a revalidation.
   */
  readonly resume: ResumeSignal;
}

/**
 * Fetches the two full-screen pictures of the current stage's clear effect as soon as the team is
 * on the stage, so ② and ③ open with the picture already there (Issue #378, #371). The opening
 * (Issue #379) has usually fetched them already, and the preloader does not ask twice; this one
 * still asks again for what failed there: once per stage entered, and again on resume. The
 * refetches that keep the same stage ask for nothing again.
 */
export const useClearPortraitPreload = (deps: ClearPortraitPreloadDeps): void => {
  const preload = (stage: GameStageId | null): void => {
    if (stage === null) return;
    for (const src of clearPortraitSrcs(stage)) void deps.preloader.preload(src);
  };

  watch(deps.stage, preload, { immediate: true });

  const stopListening = deps.resume.subscribe(() => {
    preload(deps.stage());
  });
  onScopeDispose(stopListening);
};
