import { stage3Calls, stage5Call } from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import { callScene } from "../../../src/stages/common/call-scene.js";

describe("callScene（叱責の内線を全画面で出す）", () => {
  it("Stage 3 の皮膚科医：肖像を切らずに収め、名札は役職だけ、内線の見出しを添える", () => {
    expect(callScene(stage3Calls.scold)).toEqual({
      art: {
        src: `/assets/images/production/${stage3Calls.scold.img}`,
        position: "50% 50%",
        fit: "contain",
      },
      name: stage3Calls.scold.role,
      caption: stage3Calls.scold.tb,
    });
  });

  it("Stage 5 の事務長：名札は「所属 役職」", () => {
    const scene = callScene(stage5Call);
    expect(scene.name).toBe(`${stage5Call.org} ${stage5Call.role}`);
    expect(scene.art.src).toBe(`/assets/images/production/${stage5Call.img}`);
    expect(scene.art.fit).toBe("contain");
    expect(scene.caption).toBe(stage5Call.tb);
  });

  it("所属が空文字なら役職だけ", () => {
    expect(callScene({ tb: "t", img: "a.png", role: "医師", org: "" }).name).toBe("医師");
  });
});
