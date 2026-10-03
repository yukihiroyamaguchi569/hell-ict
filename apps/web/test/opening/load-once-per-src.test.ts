import { describe, expect, it } from "vitest";

import { loadOncePerSrc } from "../../src/browser-ports.js";
import type { PreloadResult } from "../../src/ports.js";

/** A loader whose answers the test gives by hand, recording each src it was asked for. */
const manualLoader = () => {
  const asked: string[] = [];
  const answers: ((result: PreloadResult) => void)[] = [];
  const load = (src: string): Promise<PreloadResult> => {
    asked.push(src);
    return new Promise((resolve) => {
      answers.push(resolve);
    });
  };
  return { asked, answers, preloader: loadOncePerSrc(load) };
};

describe("loadOncePerSrc", () => {
  it("読み込み中の同じ src は取り直さず、同じ答えを返す（全体とステージ単位の先読みが重なっても1回）", async () => {
    const { asked, answers, preloader } = manualLoader();
    const first = preloader.preload("/a.webp");
    const second = preloader.preload("/a.webp");
    expect(asked).toEqual(["/a.webp"]);
    answers[0]?.("loaded");
    await expect(first).resolves.toBe("loaded");
    await expect(second).resolves.toBe("loaded");
  });

  it("読み終えた src は次に頼まれても取り直さない", async () => {
    const { asked, answers, preloader } = manualLoader();
    const first = preloader.preload("/a.webp");
    answers[0]?.("loaded");
    await first;
    await expect(preloader.preload("/a.webp")).resolves.toBe("loaded");
    expect(asked).toEqual(["/a.webp"]);
  });

  it("失敗した src は次に頼まれたら取り直す（通信が戻ったときの再試行）", async () => {
    const { asked, answers, preloader } = manualLoader();
    const first = preloader.preload("/a.webp");
    answers[0]?.("failed");
    await expect(first).resolves.toBe("failed");
    const retry = preloader.preload("/a.webp");
    expect(asked).toEqual(["/a.webp", "/a.webp"]);
    answers[1]?.("loaded");
    await expect(retry).resolves.toBe("loaded");
  });

  it("別の src はそれぞれ取りに行く", () => {
    const { asked, preloader } = manualLoader();
    void preloader.preload("/a.webp");
    void preloader.preload("/b.png");
    expect(asked).toEqual(["/a.webp", "/b.png"]);
  });
});
