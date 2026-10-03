import { stage1Memo } from "@hell-ict/content";
import { DEADLINE_GRACE_MS, STAGE1_REPLY_LIMIT_MS } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  stage1CanOpen,
  stage1LandedKeys,
  stage1MailText,
  stage1NewLandings,
  stage1Rows,
  STAGE1_MEMO_ROW_ID,
} from "../../../src/stages/s1/s1-view.js";
import { stage1, T0 } from "./fake-session.js";

const ids = (rows: ReturnType<typeof stage1Rows>) => rows.map((row) => row.id);

describe("stage1Rows", () => {
  it("開始直後はメモと、着弾ちょうどの1通目だけ", () => {
    const rows = stage1Rows(stage1(), T0);
    expect(ids(rows)).toEqual([STAGE1_MEMO_ROW_ID, "m1"]);
    expect(rows[0]).toMatchObject({ pinned: true, from: stage1Memo.from, status: "live" });
    expect(rows[1]).toMatchObject({ pinned: false, status: "live", dueAt: T0 + 60_000 });
  });

  it("着弾の 1ms 前の1通は出さない", () => {
    expect(ids(stage1Rows(stage1(), T0 + 4_999))).toEqual([STAGE1_MEMO_ROW_ID, "m1"]);
    expect(ids(stage1Rows(stage1(), T0 + 5_000))).toEqual([STAGE1_MEMO_ROW_ID, "m1", "m2"]);
  });

  it("残り時間の短い順、返信済み・時間切れは後ろ。メモは締切が過ぎても先頭のまま", () => {
    const now = T0 + STAGE1_REPLY_LIMIT_MS + DEADLINE_GRACE_MS + 1;
    const rows = stage1Rows(stage1({ doneIds: ["m2"] }), now);
    expect(ids(rows)).toEqual([STAGE1_MEMO_ROW_ID, "m3", "m4", "m8", "m1", "m2"]);
    expect(rows.map((row) => row.status)).toEqual([
      "missed",
      "live",
      "live",
      "live",
      "missed",
      "done",
    ]);
  });

  it("ラウンドごとにそのラウンドのメールを出す", () => {
    const rows = stage1Rows(stage1({ round: 3, r3Try: 1, memoReplied: true }), T0 + 30_000);
    expect(ids(rows)).toEqual([STAGE1_MEMO_ROW_ID, "t1", "t3", "t4", "t5", "t6"]);
    expect(rows[0]?.status).toBe("done");
  });
});

describe("stage1CanOpen と stage1MailText", () => {
  it("開けるのは live の行だけ、一覧に無いものは開けない", () => {
    const rows = stage1Rows(stage1({ doneIds: ["m1"] }), T0 + 6_000);
    expect(stage1CanOpen(rows, "m2")).toBe(true);
    expect(stage1CanOpen(rows, STAGE1_MEMO_ROW_ID)).toBe(true);
    expect(stage1CanOpen(rows, "m1")).toBe(false);
    expect(stage1CanOpen(rows, "m3")).toBe(false);
  });

  it("メールの文面を ID で引く", () => {
    expect(stage1MailText("t6")?.from).toBe("前任ICN");
  });
});

describe("stage1LandedKeys と stage1NewLandings", () => {
  const key = (id: string, roundStartedAt = T0) => `${String(roundStartedAt)}:${id}`;

  it("着弾したメールだけを、ラウンドの開始時刻つきで数える（着弾の 1ms 前は数えない）", () => {
    expect(stage1LandedKeys(null, T0)).toEqual([]);
    expect(stage1LandedKeys(stage1(), T0 + 4_999)).toEqual([key("m1")]);
    expect(stage1LandedKeys(stage1(), T0 + 5_000)).toEqual([key("m1"), key("m2")]);
  });

  it("まだ鳴らしていない分だけが新しい。基準が無い（null）うちは何も新しくない", () => {
    const heard = new Set(stage1LandedKeys(stage1(), T0));
    const after = stage1LandedKeys(stage1(), T0 + 11_000);
    expect(stage1NewLandings(heard, after)).toEqual([key("m2"), key("m3")]);
    expect(stage1NewLandings(new Set(after), after)).toEqual([]);
    expect(stage1NewLandings(null, after)).toEqual([]);
    expect(stage1NewLandings(new Set(), after)).toHaveLength(3);
  });

  it("鳴らしたメールは、時計が戻って一覧から消えた後に再び届いても新しくない", () => {
    const heard = new Set(stage1LandedKeys(stage1(), T0 + 5_000));
    expect(stage1LandedKeys(stage1(), T0 + 4_000)).toEqual([key("m1")]);
    expect(stage1NewLandings(heard, stage1LandedKeys(stage1(), T0 + 5_000))).toEqual([]);
  });

  it("R3 のやり直しは同じメールでも新しく届いたことになる", () => {
    const first = stage1({ round: 3, r3Try: 1, roundStartedAt: T0 });
    const again = stage1({ round: 3, r3Try: 2, roundStartedAt: T0 + 120_000 });
    const heard = new Set(stage1LandedKeys(first, T0 + 119_000));
    expect(heard.size).toBe(5);
    const again1 = stage1LandedKeys(again, T0 + 120_000);
    expect(again1).toEqual([key("t1", T0 + 120_000)]);
    expect(stage1NewLandings(heard, again1)).toEqual(again1);
  });
});
