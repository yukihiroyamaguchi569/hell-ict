import { describe, expect, it } from "vitest";

import {
  dueBarWidth,
  inboxAction,
  inboxView,
  landingIds,
  type InboxDraw,
} from "../../src/inbox/inbox-view.js";
import type { InboxRow } from "../../src/stages/stage-module.js";

const row = (id: string, extra: Partial<InboxRow> = {}): InboxRow => ({
  id,
  from: `差出人${id}`,
  subject: `件名${id}`,
  opens: { kind: "center" },
  ...extra,
});

describe("inboxView", () => {
  it("開いていない行は未読で数え、開いた行は既読で数えない", () => {
    const view = inboxView([row("a"), row("b"), row("c")], new Set(["b"]), null);
    expect(view.items.map((item) => item.read)).toEqual([false, true, false]);
    expect(view.unread).toBe(2);
  });

  it("行が無ければ空で、バッジは0", () => {
    expect(inboxView([], new Set(["a"]), "a")).toEqual({ items: [], unread: 0 });
  });

  it("締め切られた行は開いていなくても既読の見た目で、数えない", () => {
    const view = inboxView([row("a", { closed: true })], new Set(), null);
    expect(view.items[0]?.read).toBe(true);
    expect(view.unread).toBe(0);
  });

  it("ステージが unread を言えばそれに従う（Stage 1 は開いても返信待ちなら数える）", () => {
    const view = inboxView(
      [
        row("a", { unread: true }),
        row("b", { unread: false }),
        row("c", { closed: true, unread: true }),
      ],
      new Set(["a"]),
      null,
    );
    expect(view.items[0]?.read).toBe(true);
    expect(view.unread).toBe(2);
  });

  it("中央で開いている行だけ current", () => {
    const view = inboxView([row("a"), row("b")], new Set(), "b");
    expect(view.items.map((item) => item.current)).toEqual([false, true]);
  });

  it("同じ id の行は最初の1行だけ残す（キーが重なると行が混ざる）", () => {
    const view = inboxView([row("a"), row("b"), row("a", { subject: "後の方" })], new Set(), null);
    expect(view.items.map((item) => item.row.subject)).toEqual(["件名a", "件名b"]);
    expect(view.unread).toBe(2);
  });

  it("同じ行を作り直しても、キーと並びは変わらない（250ms ごとの描き直しで行を差し替えない）", () => {
    const at = (text: string) => [
      row("memo", { pinned: true }),
      row("m1", { due: { text, ratio: 0.5, hot: false } }),
    ];
    const before = inboxView(at("00:30"), new Set(), null);
    const after = inboxView(at("00:29"), new Set(), null);
    expect(after.items.map((item) => item.row.id)).toEqual(before.items.map((item) => item.row.id));
  });

  it("共通部品は Prologue の3通を持たない: ステージが渡した行だけを出す", () => {
    const view = inboxView([row("s1-a")], new Set(), null);
    expect(view.items.map((item) => item.row.id)).toEqual(["s1-a"]);
  });
});

describe("inboxAction", () => {
  const rows = [
    row("center"),
    row("viewer", { opens: { kind: "viewer", doc: "s3manual" } }),
    row("stage", { opens: { kind: "stage" } }),
    row("closed", { closed: true }),
  ];

  it("行の開き方をそのまま返す", () => {
    expect(inboxAction(rows, "center")).toEqual({ kind: "center" });
    expect(inboxAction(rows, "viewer")).toEqual({ kind: "viewer", doc: "s3manual" });
    expect(inboxAction(rows, "stage")).toEqual({ kind: "stage" });
  });

  it("締め切られた行と、もう無い行は何もしない", () => {
    expect(inboxAction(rows, "closed")).toBeNull();
    expect(inboxAction(rows, "gone")).toBeNull();
  });
});

describe("dueBarWidth", () => {
  it("0〜1 を百分率にし、範囲の外は端に丸める", () => {
    expect(dueBarWidth(0.5)).toBe("50%");
    expect(dueBarWidth(0)).toBe("0%");
    expect(dueBarWidth(1)).toBe("100%");
    expect(dueBarWidth(-0.2)).toBe("0%");
    expect(dueBarWidth(1.5)).toBe("100%");
  });
});

describe("landingIds", () => {
  const none: ReadonlySet<string> = new Set();
  const s2 = (...ids: string[]): InboxDraw => ({ stage: "s2", ids });
  const s3 = (...ids: string[]): InboxDraw => ({ stage: "s3", ids });

  it("初回の描画では何も揺らさない（再読み込み直後に既にある行は着弾済み）", () => {
    expect([...landingIds(none, undefined, s2("a", "b"))]).toEqual([]);
  });

  it("前回の描画に無かった行だけを揺らす", () => {
    expect([...landingIds(none, s2("a", "b"), s2("c", "a", "b"))]).toEqual(["c"]);
  });

  it("同じ行は二度揺らさない：揺れ終えた後の再描画では揺らさない", () => {
    expect([...landingIds(none, s2("c", "a"), s2("c", "a"))]).toEqual([]);
  });

  it("揺れている最中の再描画では揺れを続ける（250msごとの再描画で切らない）", () => {
    expect([...landingIds(new Set(["c"]), s2("c", "a"), s2("c", "a"))]).toEqual(["c"]);
  });

  it("消えた行は揺れの対象から外す", () => {
    expect([...landingIds(new Set(["c"]), s2("c", "a"), s2("a"))]).toEqual([]);
  });

  it("行が空になっても、空から増えても扱える", () => {
    expect([...landingIds(none, s2("a"), s2())]).toEqual([]);
    expect([...landingIds(none, s2(), s2("a", "b"))]).toEqual(["a", "b"]);
  });

  it("初回の描画では、残っていた揺れも捨てる", () => {
    expect([...landingIds(new Set(["a"]), undefined, s2("a"))]).toEqual([]);
  });

  it("ステージが変わったら揺らさない：新しいステージの受信トレイは初回の描画と同じ", () => {
    expect([...landingIds(none, s2("a"), s3("x", "y", "z"))]).toEqual([]);
  });

  it("ステージが変わったら、揺れの途中の行も止める", () => {
    expect([...landingIds(new Set(["a"]), s2("a"), s3("a", "x"))]).toEqual([]);
  });

  it("ステージが変わった後の描画からは、新しい行を揺らす", () => {
    expect([...landingIds(none, s3("x"), s3("w", "x"))]).toEqual(["w"]);
  });
});
