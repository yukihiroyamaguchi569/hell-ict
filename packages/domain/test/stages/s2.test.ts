import { describe, expect, it } from "vitest";

import { stageJudgementSchema } from "../../src/schemas/game.js";
import {
  isStage2AddendumLanded,
  isStage2AddendumTaken,
  isStage2AiUnlocked,
  judgeStage2,
  STAGE2_ADDENDUM_ROW_COUNT,
  STAGE2_AI_UNLOCK_DELAY_MS,
  STAGE2_BASE_ROW_COUNT,
  STAGE2_DEADLINE_MS,
  stage2AcceptedRowCounts,
  stage2DeadlineAt,
  stage2ExpectedRowCount,
  stage2ScriptedTable,
  stage2SecondsLeft,
  stage2StateSchema,
  startStage2,
  resetStage2Grid,
  takeStage2Addendum,
} from "../../src/stages/s2.js";
import type { Stage2State } from "../../src/stages/s2.js";
import { normalizeStage2Rows, readStage2TableForGrid } from "../../src/stages/s2-table.js";
import type { Stage2Row } from "../../src/stages/s2-table.js";
import { toStageJudgement } from "../../src/stages/stage-judgement.js";
import { ADDENDUM_ROWS, SHEET_ROWS } from "./fixtures/s2-material.js";

const T0 = 1_790_000_000_000;
const at = (ms: number): number => T0 + ms;
const fresh = startStage2(T0);
const taken: Stage2State = { startedAt: T0, addendumTakenAt: at(300_000) };

const good = (n: number): Stage2Row[] =>
  Array.from({ length: n }, (_, i) => [
    String(i + 1).padStart(3, "0"),
    "5A",
    "2026-07-03",
    "陽性",
    "あり",
    "",
  ]);

const withCell = (rows: Stage2Row[], r: number, c: number, value: string): Stage2Row[] =>
  rows.map(
    (row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row) as Stage2Row,
  );

describe("Stage 2: 定数", () => {
  it("モックの S2_ROWS / S2_ADDENDUM_ROWS / S2_DEADLINE / S2_KARUBE_DELAY と同じ", () => {
    expect(STAGE2_BASE_ROW_COUNT).toBe(20);
    expect(STAGE2_ADDENDUM_ROW_COUNT).toBe(ADDENDUM_ROWS.length);
    expect(STAGE2_DEADLINE_MS).toBe(300_000);
    expect(STAGE2_AI_UNLOCK_DELAY_MS).toBe(45_000);
  });

  it("配布版の患者行は20（ノイズ行を除く）", () => {
    expect(normalizeStage2Rows(SHEET_ROWS)).toHaveLength(STAGE2_BASE_ROW_COUNT);
  });

  it("はじまりは未取り込み", () => {
    expect(fresh).toEqual({ startedAt: T0, addendumTakenAt: null });
    expect(isStage2AddendumTaken(fresh)).toBe(false);
    expect(isStage2AddendumTaken(taken)).toBe(true);
    expect(stage2DeadlineAt(fresh)).toBe(at(300_000));
  });
});

describe("Stage 2: 5分の締切と追加分の着弾（Fake Clock）", () => {
  it.each([
    [0, false],
    [299_999, false],
    [300_000, true],
    [300_001, true],
    [3_600_000, true],
  ])("開始 %ims → 着弾 %s", (elapsed, expected) => {
    expect(isStage2AddendumLanded(fresh, at(elapsed))).toBe(expected);
  });

  it("追加分は1回だけ着弾する（着弾は時刻から決まり、一度着いたら戻らない）", () => {
    const timeline = [0, 100_000, 299_999, 300_000, 300_250, 301_000, 900_000];
    const landed = timeline.map((ms) => isStage2AddendumLanded(fresh, at(ms)));
    const landings = landed.filter((now, i) => now && !(landed[i - 1] ?? false));
    expect(landings).toHaveLength(1);
    expect(landed).toEqual([false, false, false, true, true, true, true]);
  });

  it.each([
    [0, 300],
    [999, 300],
    [1_000, 299],
    [299_000, 1],
    [299_999, 1],
    [300_000, 0],
    [400_000, 0],
  ])("開始 %ims → 残り %i 秒（モックの表示と同じ切り捨て）", (elapsed, expected) => {
    expect(stage2SecondsLeft(fresh, at(elapsed))).toBe(expected);
  });

  it.each([
    [44_999, false],
    [45_000, true],
  ])("開始 %ims → AI パネル解禁 %s", (elapsed, expected) => {
    expect(isStage2AiUnlocked(fresh, at(elapsed))).toBe(expected);
  });

  it("期待行数は着弾で 20 → 30（取り込んだかでは変わらない）", () => {
    expect(stage2ExpectedRowCount(fresh, at(299_999))).toBe(20);
    expect(stage2ExpectedRowCount(fresh, at(300_000))).toBe(30);
    expect(stage2ExpectedRowCount(taken, at(300_000))).toBe(30);
  });

  it.each([
    [299_999, [20]],
    [300_000, [20, 30]],
    [301_999, [20, 30]],
    [302_000, [30]],
  ])("開始 %ims → 通す行数 %j（猶予2秒は20行も通す）", (elapsed, expected) => {
    expect(stage2AcceptedRowCounts(fresh, at(elapsed))).toEqual(expected);
  });
});

describe("Stage 2: [表に追加]（モックの btn-take）", () => {
  it("着弾前は押せない。表も状態も変えない", () => {
    const grid = good(20);
    const result = takeStage2Addendum(fresh, grid, ADDENDUM_ROWS, at(299_999));
    expect(result.judgement).toEqual({ outcome: "reject", reason: "not-landed" });
    expect(result.state).toBe(fresh);
    expect(result.grid).toBe(grid);
  });

  it("着弾後に1回だけ取り込める。10行は表の末尾へ、1回だけ入る", () => {
    const grid = good(20);
    const first = takeStage2Addendum(fresh, grid, ADDENDUM_ROWS, at(300_000));
    expect(first.judgement).toEqual({ outcome: "accepted" });
    expect(first.state).toEqual(taken);
    expect(first.grid).toEqual([...grid, ...ADDENDUM_ROWS]);
    const late = takeStage2Addendum(fresh, grid, ADDENDUM_ROWS, at(400_000));
    expect(late.state).toEqual({ startedAt: T0, addendumTakenAt: at(400_000) });
    const second = takeStage2Addendum(first.state, first.grid, ADDENDUM_ROWS, at(301_000));
    expect(second.judgement).toEqual({ outcome: "reject", reason: "already-taken" });
    expect(second.state).toBe(first.state);
    expect(second.grid).toHaveLength(30);
  });

  it("手で直している途中の表にもそのまま足す（元の表と教材は書き換えない）", () => {
    const grid = good(3);
    const result = takeStage2Addendum(fresh, grid, ADDENDUM_ROWS, at(300_000));
    expect(result.grid).toHaveLength(13);
    expect(grid).toHaveLength(3);
    const [firstAdded] = result.grid.slice(3);
    if (firstAdded === undefined) throw new Error("the addendum must be appended");
    firstAdded[0] = "changed";
    expect(ADDENDUM_ROWS[0]?.[0]).toBe("021");
  });
});

describe("Stage 2: [最初の状態に戻す]（モックの btn-reset）", () => {
  it("取り込む前は配布版だけ", () => {
    expect(resetStage2Grid(fresh, SHEET_ROWS, ADDENDUM_ROWS)).toEqual(SHEET_ROWS);
  });

  it("取り込んだ後は追加分も残す", () => {
    expect(resetStage2Grid(taken, SHEET_ROWS, ADDENDUM_ROWS)).toEqual([
      ...SHEET_ROWS,
      ...ADDENDUM_ROWS,
    ]);
  });

  it("戻した表を書き換えても教材は変わらない", () => {
    const grid = resetStage2Grid(fresh, SHEET_ROWS, ADDENDUM_ROWS);
    const [firstRow] = grid;
    if (firstRow === undefined) throw new Error("the sheet must not be empty");
    firstRow[0] = "changed";
    expect(SHEET_ROWS[0]?.[0]).toBe("5A病棟の状況　7月分");
  });
});

describe("judgeStage2（モックの checkGrid）: 判定の順と光らせるセル", () => {
  it("正しい20行は締切前に通る", () => {
    expect(judgeStage2(good(20), fresh, at(1_000))).toEqual({ outcome: "pass" });
  });

  it("空欄: 備考以外の5列。空白だけも空欄", () => {
    const rows = withCell(withCell(good(20), 0, 0, " "), 3, 4, "");
    expect(judgeStage2(withCell(rows, 5, 5, ""), fresh, at(1_000))).toEqual({
      outcome: "reject",
      check: "required-cells",
      cells: [
        { row: 0, column: 0 },
        { row: 3, column: 4 },
      ],
    });
  });

  it("空欄が先。日付や MRSA が崩れていても空欄だけを返す", () => {
    const rows = withCell(withCell(good(20), 0, 1, ""), 1, 2, "7/3");
    expect(judgeStage2(rows, fresh, at(1_000))).toMatchObject({ check: "required-cells" });
  });

  it("日付: YYYY-MM-DD 以外。前後の空白は許す", () => {
    const rows = withCell(
      withCell(withCell(good(20), 1, 2, "7/3"), 2, 2, "2026-7-03"),
      3,
      2,
      " 2026-07-03 ",
    );
    expect(judgeStage2(rows, fresh, at(1_000))).toEqual({
      outcome: "reject",
      check: "collection-date",
      cells: [
        { row: 1, column: 2 },
        { row: 2, column: 2 },
      ],
    });
  });

  it("日付: 要確認は1件まで許す。2件目から光る", () => {
    const one = withCell(good(20), 4, 2, "要確認");
    expect(judgeStage2(one, fresh, at(1_000))).toEqual({ outcome: "pass" });
    const two = withCell(withCell(one, 7, 2, " 要確認 "), 9, 2, "要確認");
    expect(judgeStage2(two, fresh, at(1_000))).toEqual({
      outcome: "reject",
      check: "collection-date",
      cells: [
        { row: 7, column: 2 },
        { row: 9, column: 2 },
      ],
    });
  });

  it.each(["x2026-07-03", "2026-07-03x", "2026-07-031"])(
    "日付: 前後に余分な文字がある %j は通さない",
    (value) => {
      expect(judgeStage2(withCell(good(20), 0, 2, value), fresh, at(1_000))).toMatchObject({
        check: "collection-date",
      });
    },
  );

  it("日付: 全角数字の ISO は通さない", () => {
    expect(judgeStage2(withCell(good(20), 0, 2, "２０２６-07-03"), fresh, at(1_000))).toMatchObject(
      {
        check: "collection-date",
      },
    );
  });

  it("MRSA: 陽性/陰性の2値だけ", () => {
    const rows = withCell(withCell(withCell(good(20), 0, 3, "(+)"), 1, 3, " 陰性 "), 2, 3, "陽性?");
    expect(judgeStage2(rows, fresh, at(1_000))).toEqual({
      outcome: "reject",
      check: "mrsa-result",
      cells: [
        { row: 0, column: 3 },
        { row: 2, column: 3 },
      ],
    });
  });

  it("発熱列は中身を見ない（埋まっていればよい）", () => {
    expect(judgeStage2(withCell(good(20), 0, 4, "謎"), fresh, at(1_000))).toEqual({
      outcome: "pass",
    });
  });

  it.each([
    [19, 1_000, "count-mismatch", 20],
    [21, 1_000, "count-mismatch", 20],
    [0, 1_000, "count-mismatch", 20],
  ])("行数 %i（開始 %ims）→ %s", (count, elapsed, reason, expected) => {
    expect(judgeStage2(good(count), fresh, at(elapsed))).toEqual({
      outcome: "reject",
      check: "row-count",
      reason,
      expected,
      actual: count,
    });
  });

  it("締切前に30行は通らない", () => {
    expect(judgeStage2(good(30), taken, at(299_999))).toMatchObject({
      check: "row-count",
      reason: "count-mismatch",
      expected: 20,
    });
  });

  it("着弾後、取り込んでいなければ addendum-not-taken", () => {
    expect(judgeStage2(good(20), fresh, at(302_000))).toEqual({
      outcome: "reject",
      check: "row-count",
      reason: "addendum-not-taken",
      expected: 30,
      actual: 20,
    });
  });

  it("着弾後、取り込み済みで行数が違えば count-mismatch", () => {
    expect(judgeStage2(good(29), taken, at(302_000))).toMatchObject({
      reason: "count-mismatch",
      expected: 30,
      actual: 29,
    });
  });

  it("着弾後は30行で通る（取り込まずに AI の30行を貼っても通る）", () => {
    expect(judgeStage2(good(30), taken, at(302_000))).toEqual({ outcome: "pass" });
    expect(judgeStage2(good(30), fresh, at(302_000))).toEqual({ outcome: "pass" });
  });

  it("猶予: 締切の直前に出した20行が遅れて届いても通る。30行も通る", () => {
    for (const elapsed of [300_000, 301_999]) {
      expect(judgeStage2(good(20), fresh, at(elapsed))).toEqual({ outcome: "pass" });
      expect(judgeStage2(good(30), taken, at(elapsed))).toEqual({ outcome: "pass" });
    }
    expect(judgeStage2(good(20), fresh, at(302_000)).outcome).toBe("reject");
  });

  it("猶予中でも25行は通らない。期待行数は画面と同じ30", () => {
    expect(judgeStage2(good(25), taken, at(300_500))).toMatchObject({ expected: 30, actual: 25 });
  });

  it("罠は無い。toStageJudgement で状態機械の schema を満たす", () => {
    const samples = [good(20), good(3), withCell(good(20), 0, 0, "")];
    for (const grid of samples) {
      const judgement = judgeStage2(grid, fresh, at(1_000));
      expect(judgement.outcome).not.toBe("trap");
      expect(stageJudgementSchema.safeParse(toStageJudgement(judgement)).success).toBe(true);
    }
  });
});

describe("stage2ScriptedTable（台本の表。プロンプトを見ずに正解の表を返す）", () => {
  it("締切前: 見出し＋20行のタブ区切り", () => {
    const lines = stage2ScriptedTable(SHEET_ROWS, ADDENDUM_ROWS, false).split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe("患者ID\t病棟\t採取日\tMRSA結果\t発熱\t備考");
    expect(lines[1]).toBe("001\t5A\t2026-07-03\t陽性\tあり\t個室へ");
  });

  it("着弾後: 追加分の10行も入る", () => {
    const lines = stage2ScriptedTable(SHEET_ROWS, ADDENDUM_ROWS, true).split("\n");
    expect(lines).toHaveLength(31);
    expect(lines[30]).toBe("030\t5A\t2026-07-10\t陰性\tなし\t退院予定");
  });

  it.each([false, true])("[表に送る] で貼り戻すと、そのまま判定を通る（着弾 %s）", (landed) => {
    const read = readStage2TableForGrid(stage2ScriptedTable(SHEET_ROWS, ADDENDUM_ROWS, landed));
    if (read.kind !== "rows") throw new Error("the scripted table must be readable");
    const now = landed ? at(302_000) : at(1_000);
    expect(judgeStage2(read.rows, fresh, now)).toEqual({ outcome: "pass" });
  });
});

describe("stage2StateSchema", () => {
  it("正しい状態を通す（取り込み前・締切ちょうどに取り込んだ後）", () => {
    expect(stage2StateSchema.safeParse(fresh).success).toBe(true);
    expect(stage2StateSchema.safeParse(taken).success).toBe(true);
  });

  it.each([
    ["取り込みの型が違う", { startedAt: T0, addendumTakenAt: "yes" }],
    ["締切前に取り込んだ", { startedAt: T0, addendumTakenAt: at(299_999) }],
    ["旧形式（真偽値）", { startedAt: T0, addendumTaken: true }],
    [
      "余計な項目（着弾は時刻から決めるので持たない）",
      { startedAt: T0, addendumTakenAt: null, landed: true },
    ],
    ["小数の時刻", { startedAt: 1.5, addendumTakenAt: null }],
  ])("%s は拒否する", (_name, value) => {
    expect(stage2StateSchema.safeParse(value).success).toBe(false);
  });
});
