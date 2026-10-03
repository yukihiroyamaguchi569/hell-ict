import { describe, expect, it } from "vitest";

import { stageJudgementSchema } from "../../src/schemas/game.js";
import { DEADLINE_GRACE_MS } from "../../src/stages/deadline.js";
import {
  INBOX_LIMIT_MS,
  INBOX_MAIL_IDS,
  inboxDeadlineAt,
  inboxMailStatus,
  inboxStateSchema,
  judgePrologue,
  resumeInbox,
  sendInboxReply,
  startInbox,
} from "../../src/stages/inbox.js";
import type { InboxState } from "../../src/stages/inbox.js";
import { toStageJudgement } from "../../src/stages/stage-judgement.js";

const T0 = 1_790_000_000_000;
const at = (ms: number): number => T0 + ms;
const opened = startInbox(T0);
const LAST_ACCEPTED = INBOX_LIMIT_MS + DEADLINE_GRACE_MS - 1;

describe("受信トレイ: 定数とはじまり", () => {
  it("締切はモックの INBOX_LIMIT（300秒）", () => {
    expect(INBOX_LIMIT_MS).toBe(300_000);
  });

  it("3通。キーはモックの VIEWERS と同じ p0〜p2", () => {
    expect(INBOX_MAIL_IDS).toEqual(["p0", "p1", "p2"]);
  });

  it("開いた瞬間が起点で、まだ何も返していない", () => {
    expect(opened).toEqual({ openedAt: T0, sent: [] });
    expect(inboxDeadlineAt(opened)).toBe(at(300_000));
  });
});

describe("受信トレイ: 5分の締切（Fake Clock）", () => {
  it.each([
    [0, "live"],
    [299_999, "live"],
    [300_000, "live"],
    [300_001, "live"],
    [LAST_ACCEPTED, "live"],
    [LAST_ACCEPTED + 1, "missed"],
    [600_000, "missed"],
  ] as const)("開いて %ims → %s（猶予2秒込み）", (elapsed, expected) => {
    for (const mailId of INBOX_MAIL_IDS) {
      expect(inboxMailStatus(opened, mailId, at(elapsed))).toBe(expected);
    }
  });

  it("返信済みは締切を過ぎても sent のまま", () => {
    const { state } = sendInboxReply(opened, "p1", "はい", at(10_000));
    expect(inboxMailStatus(state, "p1", at(900_000))).toBe("sent");
    expect(inboxMailStatus(state, "p0", at(900_000))).toBe("missed");
  });
});

describe("受信トレイ: 返信の判定（モックの inboxSend）", () => {
  it.each([
    ["1文字でも通す（文面は見ない）", "了"],
    ["前後の空白があっても中身があれば通す", "  承知しました \n"],
    ["失礼な文面でも通す", "知らん"],
  ])("%s", (_name, text) => {
    const result = sendInboxReply(opened, "p0", text, at(1_000));
    expect(result.judgement).toEqual({ outcome: "accepted" });
    expect(result.state.sent).toEqual(["p0"]);
  });

  it.each([
    ["空文字", ""],
    ["空白だけ", "   "],
    ["改行とタブだけ", "\n\t\n"],
    ["全角空白だけ（モックの trim も全角空白を落とす）", "　　"],
  ])("%s は empty で拒否し、状態を変えない", (_name, text) => {
    const result = sendInboxReply(opened, "p0", text, at(1_000));
    expect(result.judgement).toEqual({ outcome: "reject", reason: "empty" });
    expect(result.state).toBe(opened);
  });

  it("締切（猶予込み）の直前までは送れる", () => {
    expect(sendInboxReply(opened, "p2", "はい", at(LAST_ACCEPTED)).judgement).toEqual({
      outcome: "accepted",
    });
  });

  it("締切を過ぎた返信は expired。空でも expired が先（モックは開けるかを先に見る）", () => {
    for (const text of ["はい", ""]) {
      const result = sendInboxReply(opened, "p2", text, at(LAST_ACCEPTED + 1));
      expect(result.judgement).toEqual({ outcome: "reject", reason: "expired" });
      expect(result.state).toBe(opened);
    }
  });

  it("同じメールへ二度目は already-sent で拒否し、重複を積まない", () => {
    const first = sendInboxReply(opened, "p0", "はい", at(1_000)).state;
    const second = sendInboxReply(first, "p0", "もう一度", at(2_000));
    expect(second.judgement).toEqual({ outcome: "reject", reason: "already-sent" });
    expect(second.state).toBe(first);
    expect(inboxStateSchema.safeParse(second.state).success).toBe(true);
  });

  it("返信済みの判定は締切より先（送った後に時間切れにしない）", () => {
    const first = sendInboxReply(opened, "p0", "はい", at(1_000)).state;
    expect(sendInboxReply(first, "p0", "はい", at(900_000)).judgement).toEqual({
      outcome: "reject",
      reason: "already-sent",
    });
  });

  it("元の状態を書き換えない", () => {
    const before: InboxState = { openedAt: T0, sent: [] };
    sendInboxReply(before, "p0", "はい", at(1_000));
    expect(before).toEqual({ openedAt: T0, sent: [] });
  });
});

describe("Prologue の完了（モックの inboxFrame: 3通すべて返信済みか時間切れ）", () => {
  const sendAll = (state: InboxState, ids: readonly (typeof INBOX_MAIL_IDS)[number][]) =>
    ids.reduce((acc, id) => sendInboxReply(acc, id, "はい", at(1_000)).state, state);

  it("何もしなければ、締切（猶予込み）を過ぎた瞬間に完了する", () => {
    expect(judgePrologue(opened, at(LAST_ACCEPTED))).toEqual({
      outcome: "reject",
      reason: "mails-open",
    });
    expect(judgePrologue(opened, at(LAST_ACCEPTED + 1))).toEqual({ outcome: "pass" });
  });

  it("3通とも返せば、締切前でも完了する", () => {
    expect(judgePrologue(sendAll(opened, INBOX_MAIL_IDS), at(1_000))).toEqual({ outcome: "pass" });
  });

  it("2通だけでは完了しない。残りが時間切れになれば完了する", () => {
    const state = sendAll(opened, ["p0", "p2"]);
    expect(judgePrologue(state, at(1_000)).outcome).toBe("reject");
    expect(judgePrologue(state, at(LAST_ACCEPTED + 1)).outcome).toBe("pass");
  });

  it("罰は無い: 完了は reject/pass だけで trap にならない", () => {
    expect(judgePrologue(opened, at(900_000)).outcome).not.toBe("trap");
  });

  it("toStageJudgement で状態機械の schema を満たす", () => {
    for (const now of [at(0), at(900_000)]) {
      expect(
        stageJudgementSchema.safeParse(toStageJudgement(judgePrologue(opened, now))).success,
      ).toBe(true);
    }
  });
});

describe("resumeInbox（モックの inboxLoad: 再読み込みからの復帰）", () => {
  const saved: InboxState = { openedAt: T0, sent: ["p1"] };

  it("保存した状態を読み戻す。起点は保存した時刻のまま（5分は伸びない）", () => {
    expect(resumeInbox(saved, at(200_000))).toEqual(saved);
    expect(resumeInbox(saved, T0)).toEqual(saved);
    expect(inboxMailStatus(resumeInbox(saved, at(900_000)), "p0", at(900_000))).toBe("missed");
  });

  it("起点が未来の保存は捨てて、今から始め直す", () => {
    expect(resumeInbox(saved, T0 - 1)).toEqual({ openedAt: T0 - 1, sent: [] });
  });

  it.each([
    ["無い", undefined],
    ["null", null],
    ["壊れた形", { openedAt: "x", sent: [] }],
    ["重複", { openedAt: T0, sent: ["p0", "p0"] }],
  ])("%s保存は捨てて、今から始め直す", (_name, value) => {
    expect(resumeInbox(value, at(5_000))).toEqual({ openedAt: at(5_000), sent: [] });
  });
});

describe("inboxStateSchema（保存から読み戻す値）", () => {
  it("正しい状態を通す", () => {
    expect(inboxStateSchema.safeParse({ openedAt: T0, sent: ["p0", "p2"] }).success).toBe(true);
  });

  it.each([
    ["重複した返信", { openedAt: T0, sent: ["p0", "p0"] }],
    ["知らないメール", { openedAt: T0, sent: ["p3"] }],
    ["負の時刻", { openedAt: -1, sent: [] }],
    ["余計な項目", { openedAt: T0, sent: [], draft: [] }],
    ["起点なし", { sent: [] }],
  ])("%s は拒否する", (_name, value) => {
    expect(inboxStateSchema.safeParse(value).success).toBe(false);
  });
});
