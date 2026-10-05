import { stage2RetryLine, stage2SheetRows, stage2SubmitFailed } from "@hell-ict/content";
import { STAGE2_DEADLINE_MS } from "@hell-ict/domain";
import type { Stage2Grid } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  cellKey,
  stage2CanTake,
  stage2FreshGrid,
  stage2InboxRows,
  stage2SubmitResult,
  stage2Verdict,
  withCell,
  withEmptyRow,
  withoutCell,
  withoutRow,
} from "../../../src/stages/s2/s2-view.js";
import { appliedWith, rejectedWith } from "../s1/fake-session.js";
import { s2View, T0 } from "./s2-fixtures.js";

const fresh = { startedAt: T0, addendumTakenAt: null };
const DEADLINE = T0 + STAGE2_DEADLINE_MS;
const taken = { startedAt: T0, addendumTakenAt: DEADLINE + 5_000 };

describe("グリッドの操作", () => {
  const grid: Stage2Grid = [
    ["1", "a", "b", "c", "d", ""],
    ["2", "a", "b", "c", "d", ""],
  ];

  it("セルを1つだけ書き換え、元の表は変えない", () => {
    const next = withCell(grid, 1, 2, "2026-07-03");
    expect(next[1]).toEqual(["2", "a", "2026-07-03", "c", "d", ""]);
    expect(next[0]).toBe(grid[0]);
    expect(grid[1]?.[2]).toBe("b");
  });

  it("範囲の外のセルは何も変えない", () => {
    expect(withCell(grid, 5, 0, "x")).toEqual(grid);
    expect(withCell(grid, 0, 6, "x")).toEqual(grid);
    expect(withCell(grid, 0, -1, "x")).toEqual(grid);
  });

  it("行を足すと空の6セルが末尾に付く", () => {
    expect(withEmptyRow(grid).at(-1)).toEqual(["", "", "", "", "", ""]);
  });

  it("行を消すと、その行の光るセルは消え、下の行の分は1つ繰り上がる", () => {
    const hot = new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3)]);
    const next = withoutRow([...grid, ["3", "", "", "", "", ""]], hot, 1);
    expect(next.grid.map((row) => row[0])).toEqual(["1", "3"]);
    expect([...next.hot]).toEqual([cellKey(0, 1), cellKey(1, 3)]);
  });

  it("直したセルだけ光が消える", () => {
    const hot = new Set([cellKey(0, 1), cellKey(1, 1)]);
    expect([...withoutCell(hot, 0, 1)]).toEqual([cellKey(1, 1)]);
    expect(withoutCell(hot, 3, 3)).toBe(hot);
  });

  it("最初の状態は配布版22行。追加分を取り込んだ後は32行", () => {
    expect(stage2FreshGrid(fresh)).toHaveLength(stage2SheetRows.length);
    expect(stage2FreshGrid(taken)).toHaveLength(stage2SheetRows.length + 10);
  });
});

describe("受信トレイと［表に追加］", () => {
  it("締切の前は依頼の1通だけ（既読扱い）。締切ちょうどで追加分が上に届く", () => {
    const before = stage2InboxRows(fresh, DEADLINE - 1);
    expect(before.map((row) => row.id)).toEqual(["s2-main"]);
    expect(before[0]).toMatchObject({ unread: false, opens: { kind: "viewer", doc: "main" } });
    const at = stage2InboxRows(fresh, DEADLINE);
    expect(at.map((row) => row.id)).toEqual(["s2-add", "s2-main"]);
    expect(at[0]?.opens).toEqual({ kind: "viewer", doc: "add" });
    expect(stage2InboxRows(null, DEADLINE)).toHaveLength(1);
  });

  it("［表に追加］は着弾してから取り込むまでだけ", () => {
    expect(stage2CanTake(fresh, DEADLINE - 1)).toBe(false);
    expect(stage2CanTake(fresh, DEADLINE)).toBe(true);
    expect(stage2CanTake(taken, DEADLINE + 10_000)).toBe(false);
    expect(stage2CanTake(null, DEADLINE)).toBe(false);
  });
});

describe("判定の表示", () => {
  it("合格は4項目すべての ✓（差し戻しと同じ文言）の後にクリアの一行", () => {
    expect(stage2Verdict({ outcome: "pass" }, 30)).toEqual({
      kind: "cleared",
      text: "Stage 2 をクリアしました",
      checks: [
        "✓ 必須列がすべて埋まっている",
        "✓ 採取日が YYYY-MM-DD に統一",
        "✓ MRSA結果が 陽性/陰性 の2値",
        "✓ 行数が30行",
      ],
    });
  });

  it("合格の行数の項目は、渡された期待行数を名乗る（締切前は20行）", () => {
    const verdict = stage2Verdict({ outcome: "pass" }, 20);
    expect(verdict.kind === "cleared" ? verdict.checks?.at(-1) : null).toBe("✓ 行数が20行");
  });

  it("採取日で落ちたら、前は✓・落ちた項目に件数・次は中断・最後にやり直しの案内", () => {
    const cells = [
      { row: 0, column: 2 },
      { row: 3, column: 2 },
    ];
    expect(stage2Verdict({ outcome: "reject", check: "collection-date", cells }, 20)).toEqual({
      kind: "rejected",
      lines: [
        "✓ 必須列がすべて埋まっている",
        "✗ 採取日が YYYY-MM-DD に統一　→ 2件が YYYY-MM-DD になっていません",
        "─ MRSA結果が 陽性/陰性 の2値 の確認は中断しました",
        stage2RetryLine,
      ],
    });
  });

  it("行数で落ちたら中断の行は無く、見出しは判定の期待行数", () => {
    const verdict = stage2Verdict(
      {
        outcome: "reject",
        check: "row-count",
        reason: "addendum-not-taken",
        expected: 30,
        actual: 20,
      },
      20,
    );
    expect(verdict).toEqual({
      kind: "rejected",
      lines: [
        "✓ 必須列がすべて埋まっている",
        "✓ 採取日が YYYY-MM-DD に統一",
        "✓ MRSA結果が 陽性/陰性 の2値",
        "✗ 行数が30行　→ 追加分10行がまだ表に入っていません（師長のメールの添付を開いて［表に追加］）",
        stage2RetryLine,
      ],
    });
    const mismatch = stage2Verdict(
      { outcome: "reject", check: "row-count", reason: "count-mismatch", expected: 20, actual: 19 },
      20,
    );
    expect(mismatch.kind === "rejected" && mismatch.lines[3]).toBe(
      "✗ 行数が20行　→ 20行のはずが 19行です",
    );
  });

  it("空欄と MRSA の件数", () => {
    const cells = [{ row: 1, column: 0 }];
    const empty = stage2Verdict({ outcome: "reject", check: "required-cells", cells }, 20);
    expect(empty.kind === "rejected" && empty.lines[0]).toBe(
      "✗ 必須列がすべて埋まっている　→ 1件の空欄が残っています",
    );
    const mrsa = stage2Verdict({ outcome: "reject", check: "mrsa-result", cells }, 20);
    expect(mrsa.kind === "rejected" && mrsa.lines[2]).toBe(
      "✗ MRSA結果が 陽性/陰性 の2値　→ 1件残っています（下で光っている分）",
    );
  });
});

describe("提出の答え", () => {
  const view = s2View(fresh);

  it("差し戻しは判定の文言と光るセル", () => {
    const result = stage2SubmitResult(
      {
        kind: "done",
        response: {
          status: "applied",
          events: [],
          judgement: { outcome: "reject", check: "mrsa-result", cells: [{ row: 2, column: 3 }] },
          ...view,
        },
      },
      20,
    );
    expect(result.rejected).toBe(true);
    expect([...result.hot]).toEqual([cellKey(2, 3)]);
  });

  it("合格は光らせない", () => {
    const result = stage2SubmitResult(
      {
        kind: "done",
        response: { status: "applied", events: [], judgement: { outcome: "pass" }, ...view },
      },
      20,
    );
    expect(result).toMatchObject({ rejected: false, verdict: { kind: "cleared" } });
    expect(result.hot.size).toBe(0);
  });

  it("届かなかった・断られた・読めない判定は「もう一度提出」だけ（差し戻し音も光も無し）", () => {
    for (const outcome of [
      { kind: "unavailable" } as const,
      { kind: "failed" } as const,
      rejectedWith("already-cleared", view),
      appliedWith(view),
      {
        kind: "done" as const,
        response: {
          status: "applied" as const,
          events: [],
          judgement: { outcome: "reject", check: "nonsense" },
          ...view,
        },
      },
    ]) {
      expect(stage2SubmitResult(outcome, 20)).toEqual({
        verdict: { kind: "rejected", lines: [stage2SubmitFailed] },
        hot: new Set(),
        rejected: false,
      });
    }
  });
});
