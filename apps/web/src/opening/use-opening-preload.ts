import { computed, getCurrentScope, onScopeDispose, readonly, ref } from "vue";
import type { ComputedRef, Ref } from "vue";

import type { AudioPort, ImagePreloader, PreloadResult, Scheduler } from "../ports.js";
import type { PreloadAsset } from "./preload-manifest.js";

/**
 * How long the opening waits for the assets before it lets the team in anyway (2026-10-03
 * decision). What has not arrived by then keeps loading behind the entry screen.
 */
export const OPENING_LIMIT_MS = 15_000;

/**
 * How long the rest waits for the backdrop. The backdrop goes first so that a slow line shows the
 * hospital before the bar; a backdrop that hangs must not keep the rest from starting.
 */
export const BACKDROP_HEAD_START_MS = 5_000;

export interface OpeningPreloadDeps {
  /**
   * The opening's own background, fetched alone before the rest so that a slow line shows the
   * hospital first instead of sharing its bandwidth with every other asset. It may be in `assets`
   * too: the preloader does not ask twice.
   */
  readonly backdrop: string;
  readonly assets: readonly PreloadAsset[];
  readonly images: ImagePreloader;
  readonly audio: Pick<AudioPort, "preload">;
  readonly scheduler: Scheduler;
}

export interface OpeningPreload {
  readonly total: number;
  /** Assets that have finished, loaded or failed. */
  readonly settled: Readonly<Ref<number>>;
  /** Of `settled`, the ones that failed: noted only, they are fetched again where they are used. */
  readonly failed: Readonly<Ref<number>>;
  /** Every asset has settled, or `OPENING_LIMIT_MS` has passed. Never turns back to false. */
  readonly finished: ComputedRef<boolean>;
}

const preloadOne = (deps: OpeningPreloadDeps, asset: PreloadAsset): Promise<PreloadResult> =>
  asset.kind === "image" ? deps.images.preload(asset.src) : deps.audio.preload(asset.name);

/**
 * Fetches the backdrop, then every asset of the game at once (Issue #379), and counts the assets
 * as they settle. A failure does not hold the opening: it only counts as settled. The time limit
 * runs from the start, backdrop included. The rest starts when the backdrop settles, or after
 * `BACKDROP_HEAD_START_MS` if it has not by then.
 */
export const useOpeningPreload = (deps: OpeningPreloadDeps): OpeningPreload => {
  const total = deps.assets.length;
  const settled = ref(0);
  const failed = ref(0);
  const timedOut = ref(false);
  const finished = computed(() => timedOut.value || settled.value >= total);

  let cancelLimit = (): void => undefined;
  let cancelHeadStart = (): void => undefined;
  let started = false;
  /** Starts the rest, once: when the backdrop settles or its head start runs out. */
  const preloadAll = (): void => {
    if (started) return;
    started = true;
    cancelHeadStart();
    for (const asset of deps.assets) {
      void preloadOne(deps, asset).then((result) => {
        settled.value += 1;
        if (result === "failed") failed.value += 1;
        if (settled.value >= total) cancelLimit();
      });
    }
  };

  if (total > 0) {
    cancelLimit = deps.scheduler.schedule(() => {
      timedOut.value = true;
    }, OPENING_LIMIT_MS);
    cancelHeadStart = deps.scheduler.schedule(preloadAll, BACKDROP_HEAD_START_MS);
  }
  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      cancelLimit();
      cancelHeadStart();
    });
  }
  // Whether the backdrop loaded or failed, the rest starts once it has settled.
  void deps.images.preload(deps.backdrop).then(preloadAll);

  return { total, settled: readonly(settled), failed: readonly(failed), finished };
};
