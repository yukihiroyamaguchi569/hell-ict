import { describe, expect, it } from "vitest";

import {
  DEADLINE_GRACE_MS,
  epochMsSchema,
  estimateServerOffsetMs,
  isPastDeadline,
  remainingMs,
  secondsToMs,
  toServerTime,
} from "../../src/stages/deadline.js";

describe("通信遅延の猶予", () => {
  it("猶予は約2秒（Issue #232）", () => {
    expect(DEADLINE_GRACE_MS).toBe(2_000);
  });

  it.each([
    [59_999, false],
    [60_000, false],
    [61_999, false],
    [62_000, true],
    [62_001, true],
  ])("締切60秒・now=%ims → 過ぎたか %s", (now, expected) => {
    expect(isPastDeadline(60_000, now)).toBe(expected);
  });

  it("秒をミリ秒へ", () => {
    expect(secondsToMs(60)).toBe(60_000);
    expect(secondsToMs(0)).toBe(0);
  });
});

describe("残り時間（画面の表示は猶予を含めない）", () => {
  it.each([
    [0, 60_000],
    [59_999, 1],
    [60_000, 0],
    [61_000, 0],
  ])("締切60秒・now=%ims → 残り %ims", (now, expected) => {
    expect(remainingMs(60_000, now)).toBe(expected);
  });
});

describe("serverNow による時計の補正", () => {
  it("往復の中点でサーバが時計を読んだとみなす", () => {
    expect(
      estimateServerOffsetMs({ requestSentAt: 1_000, responseReceivedAt: 1_400, serverNow: 6_200 }),
    ).toBe(5_000);
  });

  it("サーバの時計が遅れていれば負になる", () => {
    expect(
      estimateServerOffsetMs({
        requestSentAt: 10_000,
        responseReceivedAt: 10_000,
        serverNow: 7_000,
      }),
    ).toBe(-3_000);
  });

  it("補正した時刻で締切を数えれば、クライアントの時計がずれていても同じ残り時間になる", () => {
    const offset = estimateServerOffsetMs({
      requestSentAt: 500,
      responseReceivedAt: 700,
      serverNow: 100_600,
    });
    expect(toServerTime(10_600, offset)).toBe(110_600);
    expect(remainingMs(120_000, toServerTime(10_600, offset))).toBe(9_400);
  });
});

describe("epochMsSchema", () => {
  it.each([0, 1_790_000_000_000])("%i は通す", (value) => {
    expect(epochMsSchema.safeParse(value).success).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0"])("%s は拒否する", (value) => {
    expect(epochMsSchema.safeParse(value).success).toBe(false);
  });
});
