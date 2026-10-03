import { DEADLINE_GRACE_MS, sendStage1Reply, settleStage1Round } from "@hell-ict/domain";
import type { Stage1State, TeamGameViewState } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  stage1CenterMode,
  stage1ClearWindow,
  stage1InboxRows,
  stage1LogAfter,
  stage1MissionDeadline,
  stage1RoundEnd,
  stage1ShouldClose,
} from "../../../src/stages/s1/s1-screen.js";
import { stage1Rows } from "../../../src/stages/s1/s1-view.js";
import type { Stage1Row } from "../../../src/stages/s1/s1-view.js";
import { stage1, T0, viewIn } from "./fake-session.js";

const AFTER_ROUND = T0 + 83_000 + DEADLINE_GRACE_MS + 1;

const row = (patch: Partial<Stage1Row>): Stage1Row => ({
  id: "m1",
  from: "3B病棟 看護師",
  subject: "サージカルマスクの在庫について",
  pinned: false,
  status: "live",
  dueAt: T0 + 60_000,
  ...patch,
});

/** R1 ended with these replies (each sent a second after its mail landed). */
const endedRound1 = (replies: Partial<Record<"m1" | "m2" | "m3" | "m4" | "m8", string>>) => {
  const landed = [
    ["m1", 0],
    ["m2", 5],
    ["m3", 11],
    ["m4", 17],
    ["m8", 23],
  ] as const;
  let s1 = stage1();
  for (const [id, at] of landed) {
    const text = replies[id];
    if (text !== undefined) s1 = sendStage1Reply(s1, id, text, T0 + (at + 1) * 1_000).state;
  }
  return settleStage1Round(s1, AFTER_ROUND).state;
};

const POLITE = "ご連絡ありがとうございます。".repeat(6) + "よろしくお願いいたします。";

describe("stage1InboxRows", () => {
  it("生きている行は残り時間とバー、15秒で警告色。メモは先頭固定で未読に数えない", () => {
    const rows = stage1InboxRows(stage1Rows(stage1(), T0 + 45_000), T0 + 45_000);
    expect(rows.map((r) => r.id)).toEqual(["memo", "m1", "m2", "m3", "m4", "m8"]);
    expect(rows[0]).toMatchObject({ pinned: true, unread: false, closed: false });
    expect(rows[1]?.due).toEqual({ text: "00:15", ratio: 0.25, hot: true });
    expect(rows[2]?.due).toMatchObject({ text: "00:20", hot: false });
    expect(rows[1]).toMatchObject({ unread: true, opens: { kind: "center" } });
  });

  it("返信済み・時間切れは文言だけで閉じ、未読に数えない", () => {
    const [done, missed] = stage1InboxRows(
      [row({ status: "done" }), row({ id: "m2", status: "missed" })],
      T0,
    );
    expect(done).toMatchObject({ closed: true, unread: false });
    expect(done?.due).toEqual({ text: "返信済み", ratio: null, hot: false });
    expect(missed?.due).toEqual({ text: "時間切れ・返信不可", ratio: null, hot: false });
  });
});

describe("stage1CenterMode", () => {
  const live = [row({}), row({ id: "memo", pinned: true })];

  it("開始前はブリーフィング待ち", () => {
    expect(stage1CenterMode(null, [], "m1")).toBe("waiting");
  });

  it("開いている生きたメール、メモ、何も開いていない", () => {
    expect(stage1CenterMode(stage1(), live, "m1")).toBe("mail");
    expect(stage1CenterMode(stage1(), live, "memo")).toBe("memo");
    expect(stage1CenterMode(stage1(), live, null)).toBe("idle");
    expect(stage1CenterMode(stage1(), [row({ status: "done" })], "m1")).toBe("idle");
  });

  it("結果窓の裏とクリア後はメールを開かない。メモだけはラウンドに関係なく開く", () => {
    const failed = stage1({ status: { phase: "round-result", failure: "round1" } });
    expect(stage1CenterMode(failed, live, "m1")).toBe("round-end");
    expect(stage1CenterMode(failed, live, "memo")).toBe("memo");
    const cleared = endedRound1({ m1: POLITE, m2: POLITE, m3: POLITE, m4: POLITE, m8: POLITE });
    expect(stage1CenterMode(cleared, live, "m1")).toBe("cleared");
  });
});

describe("stage1ShouldClose", () => {
  it("開いたメールが生きている間は閉じない。返信済み・時間切れ・一覧から消えたら閉じる", () => {
    expect(stage1ShouldClose([row({})], null)).toBe(false);
    expect(stage1ShouldClose([row({})], "m1")).toBe(false);
    expect(stage1ShouldClose([row({ status: "done" })], "m1")).toBe(true);
    expect(stage1ShouldClose([row({ status: "missed" })], "m1")).toBe(true);
    expect(stage1ShouldClose([row({})], "r1")).toBe(true);
  });
});

describe("stage1LogAfter", () => {
  it("生きていた行が返信済み・時間切れになったら、新しいものを上に1行ずつ足す", () => {
    const before = [row({}), row({ id: "m2", subject: "研修" })];
    const after = [row({ status: "done" }), row({ id: "m2", subject: "研修", status: "missed" })];
    expect(stage1LogAfter(["前の行"], before, after)).toEqual([
      "時間切れ（もう返信できません）　研修",
      "返信した　サージカルマスクの在庫について",
      "前の行",
    ]);
  });

  it("変化が無ければ同じ配列を返す。前に無かった行（新しいラウンド）は数えない", () => {
    const log = ["前の行"];
    expect(stage1LogAfter(log, [row({})], [row({})])).toBe(log);
    expect(stage1LogAfter(log, [], [row({ status: "done" })])).toBe(log);
  });

  it("8行を超えたら古いものから落とす", () => {
    const log = Array.from({ length: 8 }, (_, i) => String(i));
    const next = stage1LogAfter(log, [row({})], [row({ status: "done" })]);
    expect(next).toHaveLength(8);
    expect(next[0]).toContain("返信した");
    expect(next.at(-1)).toBe("6");
  });
});

describe("stage1RoundEnd", () => {
  it("ラウンド中・クリア後は窓を出さない", () => {
    expect(stage1RoundEnd(stage1(), T0)).toBeNull();
    const cleared = endedRound1({ m1: POLITE, m2: POLITE, m3: POLITE, m4: POLITE, m8: POLITE });
    expect(stage1RoundEnd(cleared, AFTER_ROUND)).toBeNull();
  });

  it("R1 の時間切れ＋そっけない返信：件数、事務長、スレッドは2件まで、残りは「ほか」", () => {
    const s1 = endedRound1({ m1: "了解", m2: "はい", m3: "OK" });
    expect(stage1RoundEnd(s1, AFTER_ROUND)).toMatchObject({
      heading: "1回目、終了",
      note: expect.stringMatching(/^3 \/ 5 件。/),
      admin: expect.stringMatching(/^2件、返信が来ていないと苦情が来ています。届いた分も/),
      threads: [
        {
          heading: "3B病棟 看護師　サージカルマスクの在庫について",
          reply: "了解",
          answerFrom: "3B病棟 看護師（返信）",
        },
        { reply: "はい" },
      ],
      rest: "……ほか 1件、同じような返事が届いています。",
      voices: [],
      button: "確認した（次へ）",
    });
  });

  it("R1 の時間切れだけ：事務長は言い訳の一言、スレッドも「ほか」も無い", () => {
    const end = stage1RoundEnd(endedRound1({ m1: POLITE }), AFTER_ROUND);
    expect(end?.admin).toMatch(/^4件、.*言い訳はできませんよ。$/);
    expect(end?.threads).toEqual([]);
    expect(end?.rest).toBeNull();
  });

  it("全通返したがそっけない：件数を突きつけず、困惑の一言", () => {
    const end = stage1RoundEnd(
      endedRound1({ m1: "了解", m2: POLITE, m3: POLITE, m4: POLITE, m8: POLITE }),
      AFTER_ROUND,
    );
    expect(end?.note).toBe(
      "数だけは揃いましたが、あれで返信と言えますか。先方から困惑の声が届いております。",
    );
    expect(end?.admin).toBe(
      "全部返していただいたのは結構ですが……何件か、先方が困惑しておられます。",
    );
  });

  it("R2 の失敗：2回目の見出し、要点を書く手間の一言、困惑の声、ボタンは［確認した（次へ）］", () => {
    let r2 = stage1({ round: 2 });
    r2 = sendStage1Reply(r2, "r1", "はい", T0 + 1_000).state;
    r2 = sendStage1Reply(r2, "r2", POLITE, T0 + 6_000).state;
    const failed = settleStage1Round(r2, AFTER_ROUND).state;
    expect(failed.status).toEqual({ phase: "round-result", failure: "round2" });
    expect(stage1RoundEnd(failed, AFTER_ROUND)).toEqual({
      heading: "2回目、終了",
      note: "2 / 5 件しか返せませんでした。要点を毎回書いていては間に合いません。",
      rest: null,
      admin: "3件、返信が来ていないと苦情が来ています。届いた分も、ずいぶん簡単だったようで。",
      threads: [],
      voices: ["〔3B病棟 看護師〕……以上、でしょうか。"],
      button: "確認した（次へ）",
    });
  });

  it("R2・R3 は困惑の声（4件まで）。R3 は挑戦回数を数え、ボタンは［もう一度挑戦する］", () => {
    const r3: Stage1State = {
      ...stage1({ round: 3, r3Try: 2 }),
      doneIds: ["t1", "t3", "t4", "t5", "t6"],
      curt: (["t1", "t3", "t4", "t5", "t6"] as const).map((mailId) => ({ mailId, reply: "はい" })),
      status: { phase: "round-result", failure: "round3" },
    };
    const end = stage1RoundEnd(r3, AFTER_ROUND);
    expect(end?.heading).toBe("4回目、終了");
    expect(end?.voices).toHaveLength(4);
    expect(end?.voices[0]).toBe("〔給食課〕……以上、でしょうか。");
    expect(end?.rest).toBe("……ほか 1件、同じような返事が届いています。");
    expect(end?.threads).toEqual([]);
    expect(end?.button).toBe("もう一度挑戦する");
  });
});

describe("stage1ClearWindow", () => {
  const ALL_POLITE = { m1: POLITE, m2: POLITE, m3: POLITE, m4: POLITE, m8: POLITE };

  it("R1 を手で片付けたクリア：見出し・自力の一言（「見事です」は付けない）・［確認した（次へ）］", () => {
    const cleared = endedRound1(ALL_POLITE);
    expect(cleared.status).toEqual({ phase: "cleared", result: "manual" });
    expect(stage1ClearWindow(cleared)).toEqual({
      heading: "受信トレイが落ち着きました",
      note: "全通に返信しました。苅部さんの手を借りず、この数を自力で捌き切りました。",
      button: "確認した（次へ）",
    });
  });

  it("AI を使ったクリア（R2 以降）は AI で返した一言", () => {
    const cleared: Stage1State = {
      ...stage1({ round: 2 }),
      status: { phase: "cleared", result: "ai" },
    };
    expect(stage1ClearWindow(cleared)?.note).toBe("苅部さんに渡されたAIで、全通に返信しました。");
  });

  it("開始前・進行中・失敗の結果中は出さない", () => {
    expect(stage1ClearWindow(null)).toBeNull();
    expect(stage1ClearWindow(stage1())).toBeNull();
    expect(stage1ClearWindow(endedRound1({ m1: POLITE }))).toBeNull();
  });
});

describe("stage1MissionDeadline", () => {
  const state = (s1: Stage1State | null): TeamGameViewState => viewIn(s1).state;

  it("開いているメールかメモの締切。何も開いていない・開始前・知らない ID は出さない", () => {
    expect(stage1MissionDeadline(state(stage1()), "m2")?.at).toBe(T0 + 65_000);
    expect(stage1MissionDeadline(state(stage1()), "memo")?.at).toBe(T0 + 60_000);
    expect(stage1MissionDeadline(state(stage1()), null)).toBeNull();
    expect(stage1MissionDeadline(state(null), "m1")).toBeNull();
    expect(stage1MissionDeadline(state(stage1()), "r1")).toBeNull();
  });
});
