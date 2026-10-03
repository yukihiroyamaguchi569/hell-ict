import { opening, productionImages } from "@hell-ict/content";
import { GAME_STAGE_IDS } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { SFX_NAMES } from "../../src/composables/use-sfx.js";
import { OPENING_BACKDROP, PRELOAD_ASSETS } from "../../src/opening/preload-manifest.js";
import { clearPortraitSrcs } from "../../src/overlays/clear-sheets.js";

const imageSrcs = PRELOAD_ASSETS.flatMap((asset) => (asset.kind === "image" ? [asset.src] : []));
const soundNames = PRELOAD_ASSETS.flatMap((asset) => (asset.kind === "sound" ? [asset.name] : []));

describe("PRELOAD_ASSETS", () => {
  it("production の画像すべてを /assets/images/production/ の URL で持つ", () => {
    expect(imageSrcs).toEqual(productionImages.map((file) => `/assets/images/production/${file}`));
  });

  it("画面が鳴らす効果音7種をすべて持つ", () => {
    expect(soundNames).toEqual([...SFX_NAMES]);
    expect(soundNames).toHaveLength(7);
  });

  it("同じものを2度読まない（重複が無い）", () => {
    expect(new Set(imageSrcs).size).toBe(imageSrcs.length);
    expect(new Set(soundNames).size).toBe(soundNames.length);
  });

  it("背景の病院の外観（先に読む1枚）も含む", () => {
    expect(OPENING_BACKDROP).toBe(`/assets/images/production/${opening.img}`);
    expect(imageSrcs).toContain(OPENING_BACKDROP);
  });

  it("どのステージのクリア演出の絵も含む（ステージ単位の先読みと同じ URL）", () => {
    const clearArts = GAME_STAGE_IDS.flatMap((stage) => clearPortraitSrcs(stage));
    expect(clearArts).toHaveLength(12);
    for (const src of clearArts) expect(imageSrcs).toContain(src);
  });
});
