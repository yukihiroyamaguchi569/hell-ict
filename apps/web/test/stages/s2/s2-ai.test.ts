import { stage2KarubeLines } from "@hell-ict/content";
import { STAGE2_AI_UNLOCK_DELAY_MS, STAGE2_DEADLINE_MS } from "@hell-ict/domain";
import type { Stage2State } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  stage2AiCallId,
  stage2KarubeCalls,
  stage2PasteErrorText,
  stage2RightPane,
  stage2ScriptedAnswer,
} from "../../../src/stages/s2/s2-ai.js";
import { T0 } from "./s2-fixtures.js";

const started: Stage2State = { startedAt: T0, addendumTakenAt: null };
const UNLOCK = T0 + STAGE2_AI_UNLOCK_DELAY_MS;
const CALL = stage2AiCallId(started);
const READ: ReadonlySet<string> = new Set([CALL]);
const NONE: ReadonlySet<string> = new Set();

describe("stage2KarubeCalls: 45 秒で苅部さんが鳴る", () => {
  it("45 秒の1ms前は鳴らず、ちょうどで AI を点ける台詞の呼び出しが1件", () => {
    expect(stage2KarubeCalls(started, UNLOCK - 1, false)).toEqual([]);
    expect(stage2KarubeCalls(started, UNLOCK, false)).toEqual([
      { callId: CALL, lines: stage2KarubeLines },
    ]);
  });

  it("始まっていない・クリア済みなら鳴らない", () => {
    expect(stage2KarubeCalls(null, UNLOCK, false)).toEqual([]);
    expect(stage2KarubeCalls(started, UNLOCK, true)).toEqual([]);
  });

  it("GM のリセットで始め直したら別の呼び出し（もう一度鳴る）", () => {
    const again: Stage2State = { startedAt: T0 + 60_000, addendumTakenAt: null };
    expect(stage2AiCallId(again)).not.toBe(CALL);
  });
});

describe("stage2RightPane: 45 秒経過かつ苅部さんを開いたら右ペイン（決定10）", () => {
  it("開いた後、45 秒ちょうどから出る（再読み込みでも最初から）", () => {
    expect(stage2RightPane(started, UNLOCK, READ)).toBe("shown");
    expect(stage2RightPane(started, UNLOCK - 1, READ)).toBeNull();
  });

  it("開く前は 45 秒を過ぎても出ない（禁止遷移）", () => {
    expect(stage2RightPane(started, UNLOCK + 600_000, NONE)).toBeNull();
    const other: ReadonlySet<string> = new Set(["s1-intro"]);
    expect(stage2RightPane(started, UNLOCK, other)).toBeNull();
    expect(stage2RightPane(null, UNLOCK, READ)).toBeNull();
  });
});

describe("stage2ScriptedAnswer: どんな依頼にも整形済みの表", () => {
  const rows = (table: string) => table.split("\n");

  it("導入文の後にタブ区切りの見出しと20行。締切ちょうどから追加分込みの30行", () => {
    const before = stage2ScriptedAnswer(started, T0 + STAGE2_DEADLINE_MS - 1);
    expect(before.text).toBe(`整形しました。「表に送る」で提出する表に入ります。\n${before.table}`);
    expect(rows(before.table)[0]).toBe("患者ID\t病棟\t採取日\tMRSA結果\t発熱\t備考");
    expect(rows(before.table)).toHaveLength(21);
    expect(rows(stage2ScriptedAnswer(started, T0 + STAGE2_DEADLINE_MS).table)).toHaveLength(31);
  });

  it("始まる前（state が無い）は追加分を含めない", () => {
    expect(rows(stage2ScriptedAnswer(null, T0 + STAGE2_DEADLINE_MS).table)).toHaveLength(21);
  });
});

describe("stage2PasteErrorText", () => {
  it("理由ごとの文言（列の上限は6）", () => {
    expect(stage2PasteErrorText({ reason: "unclosed-quote" })).toBe("引用符が閉じていません");
    expect(stage2PasteErrorText({ reason: "too-many-columns", row: 3 })).toBe(
      "列が6つを超えています（3行目）",
    );
    expect(stage2PasteErrorText({ reason: "no-delimiter" })).toContain("タブ区切りの表で");
  });
});
