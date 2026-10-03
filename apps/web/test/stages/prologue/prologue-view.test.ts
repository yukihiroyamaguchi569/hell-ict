import { DEADLINE_GRACE_MS, INBOX_LIMIT_MS } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import { liveOpenMail, prologueRows } from "../../../src/stages/prologue/prologue-view.js";

const T0 = 1_790_000_000_000;
const inbox = { openedAt: T0, sent: ["p1" as const] };
const DEADLINE = T0 + INBOX_LIMIT_MS;

describe("prologueRows", () => {
  it("3通だけ、中央で開く。返信済みは閉じる", () => {
    const rows = prologueRows(inbox, T0);
    expect(rows.map((row) => [row.id, row.from, row.opens.kind, row.closed])).toEqual([
      ["p0", "人事課", "center", false],
      ["p1", "前任ICN", "center", true],
      ["p2", "夜勤師長", "center", false],
    ]);
    expect(rows[0]?.due).toEqual({ text: "05:00", ratio: 1, hot: false });
    expect(rows[1]?.due).toEqual({ text: "返信済み", ratio: null, hot: false });
  });

  it("残り15秒で警告色。締切を過ぎても猶予の間は開ける", () => {
    expect(prologueRows(inbox, DEADLINE - 15_001)[0]?.due?.hot).toBe(false);
    expect(prologueRows(inbox, DEADLINE - 15_000)[0]?.due?.hot).toBe(true);
    const inGrace = prologueRows(inbox, DEADLINE + DEADLINE_GRACE_MS - 1)[0];
    expect(inGrace?.closed).toBe(false);
    expect(inGrace?.due).toEqual({ text: "00:00", ratio: 0, hot: true });
  });

  it("猶予が尽きたら時間切れ・返信不可", () => {
    const row = prologueRows(inbox, DEADLINE + DEADLINE_GRACE_MS)[2];
    expect(row?.closed).toBe(true);
    expect(row?.due).toEqual({ text: "時間切れ・返信不可", ratio: null, hot: false });
  });
});

describe("liveOpenMail", () => {
  it("開いていて返信できるメールだけ", () => {
    expect(liveOpenMail(inbox, "p0", T0)).toBe("p0");
    expect(liveOpenMail(inbox, "p1", T0)).toBeNull();
    expect(liveOpenMail(inbox, "m1", T0)).toBeNull();
    expect(liveOpenMail(inbox, null, T0)).toBeNull();
    expect(liveOpenMail(null, "p0", T0)).toBeNull();
    expect(liveOpenMail(inbox, "p0", DEADLINE + DEADLINE_GRACE_MS)).toBeNull();
  });
});
