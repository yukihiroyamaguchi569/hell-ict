import { opening, productionImages } from "@hell-ict/content";

import { SFX_NAMES, type SfxName } from "../composables/use-sfx.js";
import { portraitSrc } from "../overlays/clear-sheets.js";

/** One thing the opening fetches ahead: an image by its URL, a sound effect by its name. */
export type PreloadAsset =
  | { readonly kind: "image"; readonly src: string }
  | { readonly kind: "sound"; readonly name: SfxName };

/** The opening's background (the hospital), fetched before the rest of `PRELOAD_ASSETS`. */
export const OPENING_BACKDROP = portraitSrc(opening.img);

/**
 * What the opening fetches before the entry screen (Issue #379): every production image (the
 * list lives in content and a test holds it to the files) and every sound effect the screen plays.
 * Kept in one place so that a new picture or sound is preloaded without a second list to update.
 */
export const PRELOAD_ASSETS: readonly PreloadAsset[] = [
  ...productionImages.map((file): PreloadAsset => ({ kind: "image", src: portraitSrc(file) })),
  ...SFX_NAMES.map((name): PreloadAsset => ({ kind: "sound", name })),
];
