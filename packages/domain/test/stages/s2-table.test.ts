import { describe, expect, it } from "vitest";

import {
  normalizeStage2Rows,
  parseCsv,
  parseStage2Table,
  readStage2TableForGrid,
  STAGE2_COLUMNS,
  stage2GridSchema,
  toIsoDate,
} from "../../src/stages/s2-table.js";
import type { Stage2Row } from "../../src/stages/s2-table.js";
import { SHEET_ROWS } from "./fixtures/s2-material.js";

const row = (...cells: string[]): Stage2Row => [
  cells[0] ?? "",
  cells[1] ?? "",
  cells[2] ?? "",
  cells[3] ?? "",
  cells[4] ?? "",
  cells[5] ?? "",
];

describe("parseCsv（モックの parseCsv）", () => {
  it.each([
    [
      "素の CSV",
      "a,b\nc,d",
      [
        ["a", "b"],
        ["c", "d"],
      ],
    ],
    ["引用符の中のカンマ", '"a,1",b', [["a,1", "b"]]],
    ["引用符の中の改行", '"a\nb",c', [["a\nb", "c"]]],
    ['"" は引用符1つ', '"say ""hi""",x', [['say "hi"', "x"]]],
    ["セルの前後の空白を落とす", " a , b ", [["a", "b"]]],
    [
      "空行を落とす",
      "a,b\n,\n\nc,d",
      [
        ["a", "b"],
        ["c", "d"],
      ],
    ],
    ["セルの途中の引用符は文字として扱う", 'a"b,c', [['a"b', "c"]]],
    ["閉じた引用符の後ろの文字は同じセルへ続く", '"a"b,c', [["ab", "c"]]],
    ["空文字は行なし", "", []],
  ])("%s", (_name, text, expected) => {
    expect(parseCsv(text)).toEqual(expected);
  });

  it.each([['"a,b'], ['a,"b\nc'], ['"""']])("引用符が閉じていなければ null: %j", (text) => {
    expect(parseCsv(text)).toBeNull();
  });
});

describe("parseStage2Table（モックの parseTable）", () => {
  it.each([
    ["タブ区切り", "001\t5A\n002\t5A", [row("001", "5A"), row("002", "5A")]],
    ["CSV", "001,5A\n002,5A", [row("001", "5A"), row("002", "5A")]],
    [
      "Markdown（区切り行を落とす）",
      "| 001 | 5A |\n|---|:--:|\n| 002 | 5A |",
      [row("001", "5A"), row("002", "5A")],
    ],
    [
      "コードフェンスを剥がす",
      "```tsv\n001\t5A\n002\t5A\n```",
      [row("001", "5A"), row("002", "5A")],
    ],
    ["CRLF", "001\t5A\r\n002\t5A\r\n", [row("001", "5A"), row("002", "5A")]],
    ["空行を落とす（タブ）", "001\t5A\n\n  \n002\t5A", [row("001", "5A"), row("002", "5A")]],
    ["見出し行を落とす（空白を詰めて照合）", "患者 ID\t病棟\n001\t5A", [row("001", "5A")]],
    ["見出しの1つでも一致すれば落とす", "番号\t備考\n001\t5A", [row("001", "5A")]],
    [
      "6列ちょうど",
      "1\t2\t3\t4\t5\t6\n1\t2\t3\t4\t5\t6",
      [row("1", "2", "3", "4", "5", "6"), row("1", "2", "3", "4", "5", "6")],
    ],
    [
      "7列目が空なら切り捨てて通す",
      "1\t2\t3\t4\t5\t6\t\na\tb",
      [row("1", "2", "3", "4", "5", "6"), row("a", "b")],
    ],
    ["短い行は空セルで埋める", "a\nb\tc", [row("a"), row("b", "c")]],
    [
      "Markdown が先（タブを含んでも | 始まりなら Markdown）",
      "| a\tb | c |\n| d | e |",
      [row("a\tb", "c"), row("d", "e")],
    ],
    ["タブが CSV より先", "a,b\tc\nd\te", [row("a,b", "c"), row("d", "e")]],
  ])("%s", (_name, text, rows) => {
    expect(parseStage2Table(text)).toEqual({ kind: "rows", rows });
  });

  it.each([
    ["1行だけ（セル貼り付けとして素通し）", "001\t5A\t7/3"],
    ["前後の改行を落とすと1行", "\n001,5A\n"],
    ["区切りの無い複数行", "001 5A\n002 5A"],
    ["フェンスの中が1行", "```\n001\t5A\n```"],
    ["見出し1行だけ（見出しは2行以上のときだけ落とす）", "患者ID\n"],
    ["空行と区切り行だけの Markdown", "|---|---|\n|---|---|"],
  ])("表ではない: %s", (_name, text) => {
    expect(parseStage2Table(text)).toEqual({ kind: "not-a-table" });
  });

  it("引用符が閉じていない CSV", () => {
    expect(parseStage2Table('a,"b\nc,d')).toEqual({ kind: "error", reason: "unclosed-quote" });
  });

  it("7列目に値がある行は取り込まずに拒否する（行番号は見出しを落とした後の1始まり）", () => {
    expect(parseStage2Table("患者ID\t病棟\na\tb\n1\t2\t3\t4\t5\t6\t7")).toEqual({
      kind: "error",
      reason: "too-many-columns",
      row: 2,
    });
    expect(parseStage2Table("1\t2\t3\t4\t5\t6\t7\na")).toEqual({
      kind: "error",
      reason: "too-many-columns",
      row: 1,
    });
  });

  it("全行が1列しか取れなければ区切りなし", () => {
    expect(parseStage2Table("| a |\n| b |")).toEqual({ kind: "error", reason: "no-delimiter" });
    expect(parseStage2Table('"a"\n"b",')).toEqual({
      kind: "rows",
      rows: [row("a"), row("b", "")],
    });
  });

  it("取り込んだ行はグリッドの schema を満たす", () => {
    const parsed = parseStage2Table("a,b,c\nd");
    expect(parsed.kind).toBe("rows");
    if (parsed.kind === "rows") expect(stage2GridSchema.safeParse(parsed.rows).success).toBe(true);
  });
});

describe("parseStage2Table: 似て非なる入力（モックの出力で固定）", () => {
  it.each([
    ["先頭に | が無い Markdown の行", "| a | b |\nc | d", [row("a", "b"), row("c", "d")]],
    [
      "末尾の | の後ろに文字がある Markdown の行",
      "| a | b |\n| c |d",
      [row("a", "b"), row("c", "d")],
    ],
    [
      "--- と値が混ざった行は区切り行ではない",
      "| a | --- |\n| b | c |",
      [row("a", "---"), row("b", "c")],
    ],
    [
      "--- の前に文字があるセルは区切り行ではない",
      "| x--- | y--- |\n| a | b |",
      [row("x---", "y---"), row("a", "b")],
    ],
    [
      "--- の後ろに文字があるセルは区切り行ではない",
      "| ---x | ---y |\n| a | b |",
      [row("---x", "---y"), row("a", "b")],
    ],
    ["タブ区切りのセルの前後の空白", "a \t b\n c\td ", [row("a", "b"), row("c", "d")]],
    ["CR だけの改行", "a\tb\rc\td", [row("a", "b"), row("c", "d")]],
    [
      "途中の ``` を含む行は剥がさない",
      "a\tb\nc\t```\nd\te",
      [row("a", "b"), row("c", "```"), row("d", "e")],
    ],
    [
      "途中の ``` だけの行も剥がさない",
      "a\tb\n```\nc\td",
      [row("a", "b"), row("```"), row("c", "d")],
    ],
    ["| で終わるだけの CSV は Markdown ではない", "a,b|\nc,d|", [row("a", "b|"), row("c", "d|")]],
    [
      "フェンスを剥がした後、行頭の空白の後ろの | で Markdown",
      "```\n  | a | b |\n| c | d |\n```",
      [row("a", "b"), row("c", "d")],
    ],
    ["空白を詰めてから見出しと照合する", "患者 ID\tx\n001\t5A", [row("001", "5A")]],
    [
      "見出しだけ残った表は見出しを落とさない",
      "| 患者ID | 病棟 |\n|---|---|",
      [row("患者ID", "病棟")],
    ],
  ])("%s", (_name, text, rows) => {
    expect(parseStage2Table(text)).toEqual({ kind: "rows", rows });
  });

  it("7列目に値があれば、8列目が空でも拒否する", () => {
    expect(parseStage2Table("1\t2\t3\t4\t5\t6\t7\t\na")).toEqual({
      kind: "error",
      reason: "too-many-columns",
      row: 1,
    });
  });
});

describe("readStage2TableForGrid（モックの s2SendTableToGrid の判断）", () => {
  it("読めた表はそのまま", () => {
    expect(readStage2TableForGrid("a\tb\nc\td")).toEqual({
      kind: "rows",
      rows: [row("a", "b"), row("c", "d")],
    });
  });

  it("表として読めないものは区切りなしとして拒否する（セルへ流し込まない）", () => {
    expect(readStage2TableForGrid("a b\nc d")).toEqual({ kind: "error", reason: "no-delimiter" });
    expect(readStage2TableForGrid("single")).toEqual({ kind: "error", reason: "no-delimiter" });
  });

  it("エラーはそのまま返す", () => {
    expect(readStage2TableForGrid('"a,\nb')).toEqual({ kind: "error", reason: "unclosed-quote" });
  });
});

describe("toIsoDate（モックの isoDate）", () => {
  it.each([
    ["7/3", "2026-07-03"],
    ["7月3日", "2026-07-03"],
    ["７月４日", "2026-07-04"],
    ["R8.7.3", "2026-07-03"],
    ["R8/7/5", "2026-07-05"],
    ["h8-7-5", "2026-07-05"],
    ["7.3", "2026-07-03"],
    ["7-5", "2026-07-05"],
    ["2026/07/04", "2026-07-04"],
    ["2026年7月4日", "2026-07-04"],
    ["2026-7-4", "2026-07-04"],
    ["さんにち", "要確認"],
    ["3", "要確認"],
    ["", "要確認"],
    ["12/31/99", "12-31-99"],
    ["5-6-7-8", "5-06-07"],
    ["7月3日12", "2026-07-312"],
    ["7.3R8.9", "7-03-08"],
    ["R10.7.3", "2026-07-03"],
  ])("%j → %j", (input, expected) => {
    expect(toIsoDate(input)).toBe(expected);
  });
});

describe("normalizeStage2Rows（模範解答）", () => {
  it("配布版の20行を正規化する（ノイズ行2つを落とす）", () => {
    const rows = normalizeStage2Rows(SHEET_ROWS);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual(["001", "5A", "2026-07-03", "陽性", "あり", "個室へ"]);
    expect(rows[1]).toEqual(["002", "5A", "2026-07-03", "陽性", "あり", ""]);
    expect(rows[3]).toEqual(["004", "5A", "要確認", "陽性", "あり", "家族面会あり"]);
    expect(rows[4]).toEqual(["005", "5A", "2026-07-03", "陰性", "あり", ""]);
    expect(rows[19]).toEqual(["020", "5A", "2026-07-08", "陽性", "あり", "接触者調査中"]);
  });

  it.each([
    ["(+)", "陽性"],
    ["ポジ", "陽性"],
    ["＋", "陽性"],
    ["陽性", "陽性"],
    ["(-)", "陰性"],
    ["ネガ", "陰性"],
    ["－", "陰性"],
    ["", "陰性"],
  ])("MRSA %j → %s", (mrsa, expected) => {
    expect(normalizeStage2Rows([row("1", "", "7/3", mrsa, "なし")])[0]?.[3]).toBe(expected);
  });

  it.each([
    ["なし", "なし"],
    [" なし ", "なし"],
    ["38.2℃", "あり"],
    ["あり", "あり"],
    ["", "あり"],
  ])("発熱 %j → %s", (fever, expected) => {
    expect(normalizeStage2Rows([row("1", "", "7/3", "陰性", fever)])[0]?.[4]).toBe(expected);
  });

  it("ID は数字だけ3桁、備考はそのまま", () => {
    expect(
      normalizeStage2Rows([row("No.０１１", "５Ａ", "7/5", "陰性", "なし", " メモ ")]),
    ).toEqual([["011", "5A", "2026-07-05", "陰性", "なし", " メモ "]]);
    expect(normalizeStage2Rows([row("1234", "", "7/5", "陰性", "なし")])[0]?.[0]).toBe("1234");
  });

  it("1列目だけの行はノイズ、2列目以降に値があれば残す", () => {
    expect(normalizeStage2Rows([row("タイトル"), row("", "", "", "", "", "x")])).toHaveLength(1);
  });

  it("列見出しは6列", () => {
    expect(STAGE2_COLUMNS).toEqual(["患者ID", "病棟", "採取日", "MRSA結果", "発熱", "備考"]);
  });
});
