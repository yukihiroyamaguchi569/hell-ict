import { stage3ManualText, stage5FeverTable, viewerDocs, type ViewerId } from "@hell-ict/content";
import { GAME_STAGE_IDS } from "@hell-ict/domain";
import { describe, expect, it } from "vitest";

import {
  SHARED_FOLDER_EMPTY_TEXT,
  sharedFolderItems,
} from "../../src/viewer/shared-folder-view.js";
import {
  allColumnsPicked,
  selectedColumnsText,
  toggleColumn,
  viewerSheet,
} from "../../src/viewer/viewer-view.js";

const VIEWER_IDS = Object.keys(viewerDocs).filter((id): id is ViewerId =>
  Object.hasOwn(viewerDocs, id),
);

describe("sharedFolderItems（ステージ × 共有フォルダの中身）", () => {
  const EXPECTED = {
    prologue: [],
    s1: ["s1memo"],
    s2: ["s1memo"],
    s3: ["s3contaminated", "s3manual"],
    s4: [],
    s5: [],
    s6: [],
    final: [],
  } as const;

  it.each(GAME_STAGE_IDS)("%s", (stage) => {
    expect(sharedFolderItems(stage).map((item) => item.id)).toEqual(EXPECTED[stage]);
  });

  it("Stage 3 は早見表（汚染教材）がマニュアル（正典）より上。引き継ぎメモは出さない", () => {
    const labels = sharedFolderItems("s3").map((item) => item.label);
    expect(labels).toEqual([
      `📄 ${viewerDocs.s3contaminated.name}`,
      `📄 ${viewerDocs.s3manual.name}`,
    ]);
  });

  it("Stage 3 より前は早見表もマニュアルも出さない（罠教材の先出しをしない）", () => {
    for (const stage of ["prologue", "s1", "s2"] as const) {
      const ids = sharedFolderItems(stage).map((item) => item.id);
      expect(ids).not.toContain("s3contaminated");
      expect(ids).not.toContain("s3manual");
    }
  });

  it("Stage 4 以降は空（ほかのステージの資料を AI に貼らせない）", () => {
    for (const stage of ["s4", "s5", "s6", "final"] as const) {
      expect(sharedFolderItems(stage)).toEqual([]);
    }
  });

  it("空のときの文言", () => {
    expect(SHARED_FOLDER_EMPTY_TEXT).toBe("（何もありません）");
  });
});

describe("viewerSheet（文書ごとの見せ方）", () => {
  // [文書, 折り返す, コピーを出す, 列選択あり]
  const EXPECTED: Readonly<Record<ViewerId, readonly [boolean, boolean, boolean]>> = {
    s1memo: [true, true, false],
    main: [false, true, false],
    add: [false, true, false],
    s3manual: [false, true, false],
    s3contaminated: [false, true, false],
    s3lab: [true, true, false],
    s3patients: [false, true, false],
    s4report: [true, true, false],
    s5list: [false, true, true],
    s6jimu: [true, true, false],
    s6notice: [true, false, false],
    fjimu: [true, true, false],
    fpress: [true, true, false],
  };

  it("表の行はすべての文書を網羅する", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...VIEWER_IDS].sort());
  });

  it.each(VIEWER_IDS)("%s", (id) => {
    const sheet = viewerSheet(id);
    const [wrap, copyable, hasTable] = EXPECTED[id];
    expect(sheet.name).toBe(viewerDocs[id].name);
    expect(sheet.text).toBe(viewerDocs[id].text);
    expect(sheet.wrap).toBe(wrap);
    expect(sheet.copyable).toBe(copyable);
    expect(sheet.table !== null).toBe(hasTable);
  });

  it("正典マニュアルは本文を全文そのまま出す", () => {
    const sheet = viewerSheet("s3manual");
    expect(sheet.text).toBe(stage3ManualText);
  });

  it("s5list の表は発熱患者一覧そのもの", () => {
    expect(viewerSheet("s5list").table).toEqual(stage5FeverTable);
  });
});

describe("列選択", () => {
  const TABLE = {
    header: ["ID", "氏名", "病棟"],
    rows: [
      ["1", "山田", "3B"],
      ["2", "佐藤", "5A"],
    ],
  };

  it("開いたときは全列ON。表が無ければ空", () => {
    expect(allColumnsPicked(TABLE)).toEqual([true, true, true]);
    expect(allColumnsPicked(null)).toEqual([]);
  });

  it("toggleColumn はその列だけを反転し、範囲外は何も変えない", () => {
    expect(toggleColumn([true, true, true], 1)).toEqual([true, false, true]);
    expect(toggleColumn([true, false, true], 1)).toEqual([true, true, true]);
    expect(toggleColumn([true, true], 5)).toEqual([true, true]);
    expect(toggleColumn([true, true], -1)).toEqual([true, true]);
  });

  it("全列なら見出し行つきの TSV 全体", () => {
    expect(selectedColumnsText(TABLE, [true, true, true])).toBe(
      "ID\t氏名\t病棟\n1\t山田\t3B\n2\t佐藤\t5A",
    );
  });

  it("選んだ列だけを表の列順で（氏名を外す）", () => {
    expect(selectedColumnsText(TABLE, [true, false, true])).toBe("ID\t病棟\n1\t3B\n2\t5A");
  });

  it("1列だけならタブを含まない", () => {
    expect(selectedColumnsText(TABLE, [false, false, true])).toBe("病棟\n3B\n5A");
  });

  it("0列なら null（空文字をコピーしない）", () => {
    expect(selectedColumnsText(TABLE, [false, false, false])).toBeNull();
    expect(selectedColumnsText(TABLE, [])).toBeNull();
  });

  it("行の無い表は見出し行だけ", () => {
    expect(selectedColumnsText({ header: ["A", "B"], rows: [] }, [true, true])).toBe("A\tB");
  });

  it("s5list で氏名列を外すと、どの行にも氏名が残らない", () => {
    const picked = allColumnsPicked(stage5FeverTable).map((_, i) => i !== 1);
    const text = selectedColumnsText(stage5FeverTable, picked);
    expect(text).not.toBeNull();
    for (const row of stage5FeverTable.rows) expect(text).not.toContain(row[1]);
    expect(text?.split("\n")).toHaveLength(stage5FeverTable.rows.length + 1);
  });
});
