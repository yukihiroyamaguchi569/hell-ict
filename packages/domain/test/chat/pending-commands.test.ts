import { describe, expect, it } from "vitest";

import {
  forgetPending,
  forgetPiiPending,
  mergePending,
  parseStoredPending,
  PENDING_COMMAND_LIMIT,
  PENDING_QUERY_LIMIT,
  pendingIdFor,
  pendingKey,
  pendingQueryIds,
  reconcilePending,
  storedPendingText,
} from "../../src/chat/pending-commands.js";
import type { PendingCommands } from "../../src/chat/pending-commands.js";

const THREAD_S3 = "33333333-3333-4333-8333-333333333333";
const THREAD_S4 = "44444444-4444-4444-8444-444444444444";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Hands out id(1), id(2) … and counts how many were taken. */
const idSource = () => {
  let taken = 0;
  return {
    next: (): string => id(++taken),
    get taken(): number {
      return taken;
    },
  };
};

const fill = (count: number): PendingCommands =>
  new Map(Array.from({ length: count }, (_, i) => [pendingKey(THREAD_S3, `m${String(i)}`), id(i)]));

describe("pendingKey", () => {
  it("スレッドと本文を空白1つで繋ぐ", () => {
    expect(pendingKey(THREAD_S3, "斑紋症 の 対応")).toBe(`${THREAD_S3} 斑紋症 の 対応`);
  });

  it("同じ本文でもスレッドが違えば別のキー", () => {
    expect(pendingKey(THREAD_S3, "同じ")).not.toBe(pendingKey(THREAD_S4, "同じ"));
  });
});

describe("pendingIdFor", () => {
  it("初めての本文には新しいIDを振り、最後尾に足す", () => {
    const ids = idSource();
    const key = pendingKey(THREAD_S3, "a");
    const result = pendingIdFor(new Map(), key, ids.next);
    expect(result.commandId).toBe(id(1));
    expect([...result.pending]).toEqual([[key, id(1)]]);
  });

  it("同じ宛先へ同じ本文を送り直すと同じIDで、新しいIDを取らない", () => {
    const ids = idSource();
    const key = pendingKey(THREAD_S3, "a");
    const first = pendingIdFor(new Map(), key, ids.next);
    const again = pendingIdFor(first.pending, key, ids.next);
    expect(again.commandId).toBe(id(1));
    expect(again.pending).toBe(first.pending);
    expect(ids.taken).toBe(1);
  });

  it("別スレッドへの同じ本文は別のID", () => {
    const ids = idSource();
    const s3 = pendingIdFor(new Map(), pendingKey(THREAD_S3, "同じ"), ids.next);
    const s4 = pendingIdFor(s3.pending, pendingKey(THREAD_S4, "同じ"), ids.next);
    expect(s4.commandId).toBe(id(2));
    expect(s4.pending.size).toBe(2);
  });

  it("元の Map は書き換えない", () => {
    const before = fill(1);
    pendingIdFor(before, pendingKey(THREAD_S3, "new"), idSource().next);
    expect(before.size).toBe(1);
  });

  it(`上限（${String(PENDING_COMMAND_LIMIT)}件）ちょうどまでは捨てない`, () => {
    const result = pendingIdFor(fill(PENDING_COMMAND_LIMIT - 1), "k", () => id(99));
    expect(result.pending.size).toBe(PENDING_COMMAND_LIMIT);
    expect(result.pending.get(pendingKey(THREAD_S3, "m0"))).toBe(id(0));
  });

  it("上限を超えたら最も古い1件だけを捨て、新しい1件は残す", () => {
    const result = pendingIdFor(fill(PENDING_COMMAND_LIMIT), "k", () => id(99));
    expect(result.pending.size).toBe(PENDING_COMMAND_LIMIT);
    expect(result.pending.has(pendingKey(THREAD_S3, "m0"))).toBe(false);
    expect(result.pending.get(pendingKey(THREAD_S3, "m1"))).toBe(id(1));
    expect([...result.pending].at(-1)).toEqual(["k", id(99)]);
  });
});

describe("mergePending", () => {
  const key = (text: string): string => pendingKey(THREAD_S3, text);

  it("保存分の後ろにメモリ分を並べ、同じキーはメモリの ID と位置を採る", () => {
    const stored = new Map([
      [key("a"), id(1)],
      [key("b"), id(2)],
    ]);
    const kept = new Map([
      [key("a"), id(9)],
      [key("c"), id(3)],
    ]);
    expect([...mergePending(stored, kept)]).toEqual([
      [key("b"), id(2)],
      [key("a"), id(9)],
      [key("c"), id(3)],
    ]);
  });

  it("片方が空ならもう片方のまま", () => {
    expect([...mergePending(new Map(), fill(2))]).toEqual([...fill(2)]);
    expect([...mergePending(fill(2), new Map())]).toEqual([...fill(2)]);
  });

  it("上限を超えたら古い順に捨てる（メモリ分は新しい側に残る）", () => {
    const stored = fill(PENDING_COMMAND_LIMIT);
    const kept = new Map([[key("new"), id(99)]]);
    const merged = mergePending(stored, kept);
    expect(merged.size).toBe(PENDING_COMMAND_LIMIT);
    expect(merged.has(key("m0"))).toBe(false);
    expect([...merged.values()].at(-1)).toBe(id(99));
  });
});

describe("forgetPending", () => {
  it("そのキーだけを捨て、ほかの順序は保つ", () => {
    const pending = fill(3);
    const next = forgetPending(pending, pendingKey(THREAD_S3, "m1"));
    expect([...next.values()]).toEqual([id(0), id(2)]);
    expect(pending.size).toBe(3);
  });

  it("持っていないキーなら同じものを返す", () => {
    const pending = fill(2);
    expect(forgetPending(pending, "unknown")).toBe(pending);
  });
});

describe("storedPendingText と parseStoredPending", () => {
  it("書いたものを読み戻すと同じ中身・同じ順序", () => {
    const pending = fill(3);
    expect([...parseStoredPending(storedPendingText(pending))]).toEqual([...pending]);
  });

  it("空の Map は [] として書き、空として読む", () => {
    expect(storedPendingText(new Map())).toBe("[]");
    expect(parseStoredPending("[]").size).toBe(0);
  });

  it("何も保存されていなければ空", () => {
    expect(parseStoredPending(null).size).toBe(0);
  });

  it("上限を超えて保存されていたら新しい方から上限まで残す", () => {
    const entries = Array.from({ length: PENDING_COMMAND_LIMIT + 2 }, (_, i) => [
      pendingKey(THREAD_S3, `m${String(i)}`),
      id(i),
    ]);
    const pending = parseStoredPending(JSON.stringify(entries));
    expect(pending.size).toBe(PENDING_COMMAND_LIMIT);
    expect([...pending.values()][0]).toBe(id(2));
    expect([...pending.values()].at(-1)).toBe(id(PENDING_COMMAND_LIMIT + 1));
  });

  it("本文に空白を含むキーも読める", () => {
    const key = pendingKey(THREAD_S3, " 前後 に 空白 ");
    expect(parseStoredPending(JSON.stringify([[key, id(1)]])).get(key)).toBe(id(1));
  });

  it.each([
    ["JSON でない", "{"],
    ["配列でない", JSON.stringify({ key: id(1) })],
    ["組が3要素", JSON.stringify([[pendingKey(THREAD_S3, "a"), id(1), "x"]])],
    ["組が1要素", JSON.stringify([[pendingKey(THREAD_S3, "a")]])],
    ["IDが UUID でない", JSON.stringify([[pendingKey(THREAD_S3, "a"), "not-a-uuid"]])],
    ["IDが文字列でない", JSON.stringify([[pendingKey(THREAD_S3, "a"), 1]])],
    ["キーが空", JSON.stringify([["", id(1)]])],
    ["キーに空白が無い", JSON.stringify([[THREAD_S3, id(1)]])],
    ["キーに空白が無く、末尾1字を除くと UUID", JSON.stringify([[`${THREAD_S3}x`, id(1)]])],
    ["キーの本文が空", JSON.stringify([[`${THREAD_S3} `, id(1)]])],
    ["キーが空白で始まる", JSON.stringify([[` ${THREAD_S3} a`, id(1)]])],
    ["キーの先頭が UUID でない", JSON.stringify([["thread a", id(1)]])],
    ["モックの形式（threadId・promptProfile・本文）", JSON.stringify([["t default a", id(1)]])],
  ])("%s なら丸ごと捨てる", (_label, raw) => {
    expect(parseStoredPending(raw).size).toBe(0);
  });

  it("1件だけ壊れていても、正しい組を拾わず丸ごと捨てる", () => {
    const raw = JSON.stringify([
      [pendingKey(THREAD_S3, "ok"), id(1)],
      [pendingKey(THREAD_S3, "bad"), "broken"],
    ]);
    expect(parseStoredPending(raw).size).toBe(0);
  });
});

describe("reconcilePending", () => {
  it("processed だけを捨て、pending と unknown は残す", () => {
    const pending = fill(3);
    const next = reconcilePending(pending, {
      [id(0)]: "processed",
      [id(1)]: "pending",
      [id(2)]: "unknown",
    });
    expect([...next.values()]).toEqual([id(1), id(2)]);
  });

  it("問い合わせなかった応答（commands なし）は何も捨てない", () => {
    const pending = fill(2);
    expect(reconcilePending(pending, undefined)).toBe(pending);
  });

  it("答えに載っていないIDも残す（上限で問い合わせから外れた分）", () => {
    const pending = fill(2);
    expect(
      reconcilePending(pending, { [id(0)]: "processed" }).has(pendingKey(THREAD_S3, "m1")),
    ).toBe(true);
  });

  it("捨てるものが無ければ同じものを返す", () => {
    const pending = fill(2);
    expect(reconcilePending(pending, { [id(0)]: "pending" })).toBe(pending);
  });

  it("全部 processed なら空になる", () => {
    const pending = fill(2);
    expect(reconcilePending(pending, { [id(0)]: "processed", [id(1)]: "processed" }).size).toBe(0);
  });

  it("元の Map は書き換えない", () => {
    const pending = fill(2);
    reconcilePending(pending, { [id(0)]: "processed" });
    expect(pending.size).toBe(2);
  });
});

describe("pendingQueryIds", () => {
  it("空なら何も問い合わせない", () => {
    expect(pendingQueryIds(new Map())).toEqual([]);
  });

  it("古い順に全部並べる", () => {
    expect(pendingQueryIds(fill(3))).toEqual([id(0), id(1), id(2)]);
  });

  it("同じIDは1回だけ", () => {
    const pending = new Map([
      [pendingKey(THREAD_S3, "a"), id(1)],
      [pendingKey(THREAD_S4, "a"), id(1)],
      [pendingKey(THREAD_S4, "b"), id(2)],
    ]);
    expect(pendingQueryIds(pending)).toEqual([id(1), id(2)]);
  });

  it(`上限（${String(PENDING_QUERY_LIMIT)}件）を超えたら新しい方を残す`, () => {
    const pending = new Map(
      Array.from({ length: PENDING_QUERY_LIMIT + 3 }, (_, i) => [`k${String(i)}`, id(i)]),
    );
    const ids = pendingQueryIds(pending);
    expect(ids).toHaveLength(PENDING_QUERY_LIMIT);
    expect(ids[0]).toBe(id(3));
    expect(ids.at(-1)).toBe(id(PENDING_QUERY_LIMIT + 2));
  });

  it("上限ちょうどなら全部", () => {
    expect(pendingQueryIds(fill(PENDING_QUERY_LIMIT))).toHaveLength(PENDING_QUERY_LIMIT);
  });
});

describe("forgetPiiPending", () => {
  it("本文に個人情報がある項目だけを捨て、残りの順序と id は保つ", () => {
    const pending: PendingCommands = new Map([
      [pendingKey(THREAD_S3, "先の質問"), id(1)],
      [pendingKey(THREAD_S3, "090-0000-5678 へ折り返す"), id(2)],
      [pendingKey(THREAD_S4, "後の質問"), id(3)],
    ]);
    expect([...forgetPiiPending(pending)]).toEqual([
      [pendingKey(THREAD_S3, "先の質問"), id(1)],
      [pendingKey(THREAD_S4, "後の質問"), id(3)],
    ]);
  });

  it("何も捨てなければ同じ Map を返す", () => {
    const pending: PendingCommands = new Map([[pendingKey(THREAD_S3, "質問"), id(1)]]);
    expect(forgetPiiPending(pending)).toBe(pending);
  });
});
