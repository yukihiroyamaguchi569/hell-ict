import { stage3Calls, stage5Call } from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import { DEFAULT_ART_POSITION } from "../../../src/overlays/clear-sheets.js";
import { callScene } from "../../../src/stages/common/call-scene.js";

describe("callScene（叱責の内線を全画面で出す）", () => {
  it("Stage 3 の皮膚科医：叱責用の 16:9 の絵を敷き、名札は役職だけ、内線の見出しを添える", () => {
    expect(callScene(stage3Calls.scold, stage3Calls.scoldFullscreen)).toEqual({
      art: {
        src: `/assets/images/production/${stage3Calls.scoldFullscreen.img}`,
        position: DEFAULT_ART_POSITION,
      },
      name: stage3Calls.scold.role,
      caption: stage3Calls.scold.tb,
    });
  });

  it("Stage 5 の事務長：叱責用の絵を敷き、名札は「所属 役職」", () => {
    const scene = callScene(stage5Call, stage5Call.scoldFullscreen);
    expect(scene.name).toBe(`${stage5Call.org} ${stage5Call.role}`);
    expect(scene.art.src).toBe(`/assets/images/production/${stage5Call.scoldFullscreen.img}`);
    expect(scene.caption).toBe(stage5Call.tb);
  });

  it("叱責の全画面は内線の窓の縦長の肖像を使わない", () => {
    expect(callScene(stage3Calls.scold, stage3Calls.scoldFullscreen).art.src).not.toContain(
      stage3Calls.scold.img,
    );
    expect(callScene(stage5Call, stage5Call.scoldFullscreen).art.src).not.toContain(stage5Call.img);
  });

  it("content が絵の位置を書けば、それで固定する", () => {
    const scene = callScene({ tb: "t", role: "医師" }, { img: "a.webp", position: "50% 0%" });
    expect(scene.art).toEqual({ src: "/assets/images/production/a.webp", position: "50% 0%" });
  });

  it("所属が空文字なら役職だけ", () => {
    expect(callScene({ tb: "t", role: "医師", org: "" }, { img: "a.webp" }).name).toBe("医師");
  });
});
