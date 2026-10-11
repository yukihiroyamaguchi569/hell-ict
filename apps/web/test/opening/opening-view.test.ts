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
  const wanted = (savedTeam: boolean, finished: boolean, minimumShown: boolean): boolean =>
    openingWanted({ savedTeam, finished, minimumShown });

  it("読み込み中は出し続ける（最低時間が過ぎていても）", () => {
    expect(wanted(false, false, false)).toBe(true);
    expect(wanted(false, false, true)).toBe(true);
  });

  it("読み終わっても（全部 or 15秒）、最低表示時間が過ぎるまでは出し続ける", () => {
    expect(wanted(false, true, false)).toBe(true);
  });

  it("読み終わり、最低表示時間も過ぎたら、クリックなしで入室画面へ進む", () => {
    expect(wanted(false, true, true)).toBe(false);
  });

  it("保存済みのチームの再読み込みでは出さない（復帰を待たせない）", () => {
    expect(wanted(true, false, false)).toBe(false);
    expect(wanted(true, false, true)).toBe(false);
    expect(wanted(true, true, false)).toBe(false);
    expect(wanted(true, true, true)).toBe(false);
  });
});
