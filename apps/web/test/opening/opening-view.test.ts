import { describe, expect, it } from "vitest";

import { loadingText, openingWanted, progressPercent } from "../../src/opening/opening-view.js";

describe("progressPercent", () => {
  it("終わった割合を切り捨ての整数で返す", () => {
    expect(progressPercent(0, 30)).toBe(0);
    expect(progressPercent(18, 30)).toBe(60);
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(2, 3)).toBe(66);
  });

  it("最後の1件が残る間は100にならない", () => {
    expect(progressPercent(29, 30)).toBe(96);
    expect(progressPercent(299, 300)).toBe(99);
    expect(progressPercent(30, 30)).toBe(100);
  });

  it("対象が無ければ100、範囲外の数は0〜100に収める", () => {
    expect(progressPercent(0, 0)).toBe(100);
    expect(progressPercent(31, 30)).toBe(100);
    expect(progressPercent(-1, 30)).toBe(0);
  });
});

describe("loadingText", () => {
  it("「読み込み中 60%」の形", () => {
    expect(loadingText(60)).toBe("読み込み中 60%");
    expect(loadingText(0)).toBe("読み込み中 0%");
  });
});

describe("openingWanted", () => {
  it("保存済みのチームが無く、読み込みが終わっていない間だけ出す", () => {
    expect(openingWanted({ savedTeam: false, finished: false })).toBe(true);
  });

  it("読み込みが終わったら（全部 or 15秒）入室画面へ進む", () => {
    expect(openingWanted({ savedTeam: false, finished: true })).toBe(false);
  });

  it("保存済みのチームの再読み込みでは出さない（復帰を待たせない）", () => {
    expect(openingWanted({ savedTeam: true, finished: false })).toBe(false);
    expect(openingWanted({ savedTeam: true, finished: true })).toBe(false);
  });
});
