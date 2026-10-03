import {
  stage5ChartPatient,
  stage5FeverRows,
  stage5SubmissionRejectLines,
} from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import { containsPii, stage5Patient } from "../../src/pii.js";
import { recordJudgementCommandSchema } from "../../src/schemas/game.js";
import type { StageJudgement } from "../../src/schemas/game.js";
import { judgeS5AiMessage, judgeS5Submission, S5_FEVER_IDS } from "../../src/stages/s5.js";
import type { S5RejectReason } from "../../src/stages/s5.js";
import { toStageJudgement } from "../../src/stages/stage-judgement.js";
import { nextId } from "../game/helpers.js";

/** A fever-list row other than the chart patient's. */
const [, second] = stage5FeverRows;

/** The chart's date of birth written "YYYY/MM/DD". */
const dobWithSlashes = stage5ChartPatient.dob.replace(
  /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
  (_all, y: string, m: string, d: string) => [y, m.padStart(2, "0"), d.padStart(2, "0")].join("/"),
);

/** A row of the list after cleaning: ID, ward, date, temperature (the mock's scripted table). */
type Row = { id: string; ward: string; date: string; temp: string };

const cleanRows = (): Row[] =>
  S5_FEVER_IDS.map((id, i) => ({
    id,
    ward: "5A",
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    temp: `38.${String(i % 10)}℃`,
  }));

const table = (rows: readonly Row[], sep = "\t"): string =>
  [
    ["患者ID", "病棟", "発熱確認日", "最高体温"].join(sep),
    ...rows.map((r) => [r.id, r.ward, r.date, r.temp].join(sep)),
  ].join("\n");

/** Replaces one row's field; the others stay clean. */
const withRow = (index: number, patch: Partial<Row>): Row[] =>
  cleanRows().map((row, i) => (i === index ? { ...row, ...patch } : row));

/** The expected reject, reasons in the order they are listed. */
const reject = (...reasons: [S5RejectReason, ...S5RejectReason[]]) => ({
  outcome: "reject" as const,
  reasons,
});

/** Wraps a judgement into `record-judgement` the way SV1 will: through toStageJudgement. */
const wrap = (judgement: StageJudgement) =>
  recordJudgementCommandSchema.safeParse({
    type: "record-judgement",
    commandId: nextId(),
    stage: "s5",
    judgement: toStageJudgement(judgement),
  });

describe("judgeS5AiMessage（AIチャットの送信前ゲート＝罠）", () => {
  it.each([
    ["患者氏名", `${stage5Patient.name}さんの一覧を整えて`],
    ["患者氏名", `${second.id}\t${second.name.replace(" ", "")}\t${second.ward}`],
    ["生年月日", `${dobWithSlashes}生まれ`],
    ["電話番号", "連絡先は090 0000 5678"],
    ["ご家族の氏名", `${stage5Patient.familyName}様より`],
  ])("%sを検知したら罠を返し、ラベルだけを載せる", (label, text) => {
    const judgement = judgeS5AiMessage(text);
    expect(judgement).toEqual({ outcome: "trap", detected: label });
    expect(containsPii(judgement)).toBe(false);
  });

  it("罠の判定はtoStageJudgementでrecord-judgementへ包める（ラベルは落ちる）", () => {
    const judgement = judgeS5AiMessage(stage5Patient.name);
    expect(judgement).not.toBeNull();
    if (judgement !== null) {
      expect(toStageJudgement(judgement)).toEqual({ outcome: "trap" });
      expect(wrap(judgement).success).toBe(true);
    }
  });

  it.each([
    ["氏名列を落とした一覧", table(cleanRows())],
    ["改行区切りのID列", "005\n006\n008"],
    ["空白区切りのID列（9桁）", "005 006 008"],
    ["研修当日の日付", "2026年8月22日の一覧です"],
    ["空文字", ""],
  ])("%sは送ってよい（null）", (_label, text) => {
    expect(judgeS5AiMessage(text)).toBeNull();
  });
});

describe("judgeS5Submission（保健所への提出）", () => {
  it("14名分がそろい表記も揃っていれば合格する", () => {
    expect(judgeS5Submission(table(cleanRows()))).toEqual({ outcome: "pass" });
  });

  it.each([
    ["Markdown表", table(cleanRows(), " | ")],
    ["2つ以上の空白で揃えた表", table(cleanRows(), "  ")],
    ["全角スペース2つの表", table(cleanRows(), "　　")],
    ["空白1つに潰した表（緩い区切りで拾い直す）", table(cleanRows(), " ")],
  ])("%sも合格する", (_label, text) => {
    expect(judgeS5Submission(text)).toEqual({ outcome: "pass" });
  });

  it("前置きとMarkdownの区切り行は整形チェックの対象にしない", () => {
    const text = `以下、１４名分です（005〜030）。\n|---|---|---|---|\n${table(cleanRows(), " | ")}`;
    expect(judgeS5Submission(text)).toEqual({ outcome: "pass" });
  });

  it("氏名が残っていても提出はブロックしない（罠はAIチャットの手前だけ）", () => {
    const rows = cleanRows().map((row, i) =>
      i === 0 ? { ...row, ward: stage5Patient.name } : row,
    );
    expect(judgeS5Submission(table(rows))).toEqual({ outcome: "pass" });
  });

  // S5_FEVER_IDS is derived from content's stage5FeverRows; the order is the mock's (the three
  // foreshadowed patients first), which is the order missing IDs are reported in.
  it("判定が見る患者IDは14名分で、並びはモックの一覧と同じ", () => {
    expect(S5_FEVER_IDS).toEqual([
      "005",
      "006",
      "008",
      "002",
      "004",
      "011",
      "013",
      "015",
      "017",
      "019",
      "021",
      "024",
      "027",
      "030",
    ]);
  });

  it("提出文が空なら全14名分を不足として返す", () => {
    expect(judgeS5Submission("")).toEqual(reject({ reason: "ids", missingIds: [...S5_FEVER_IDS] }));
  });

  it("不足IDは一覧の並び順で、不足分だけを返す", () => {
    const rows = cleanRows().filter((row) => row.id !== "002" && row.id !== "030");
    expect(judgeS5Submission(table(rows))).toEqual(
      reject({ reason: "ids", missingIds: ["002", "030"] }),
    );
  });

  it("IDの網羅は部分文字列で見る（モックと同じ。表の外に書いてあっても足りる）", () => {
    const rows = cleanRows().filter((row) => row.id !== "030");
    expect(judgeS5Submission(`${table(rows)}\n備考: 030は退院延期`)).toEqual({ outcome: "pass" });
  });

  it("#221: 書式の不備が3つあれば、domain の理由を content がまとめて文言にできる", () => {
    const rows = cleanRows().map((row, i) => {
      if (i === 0) return { ...row, date: "８月３日" };
      if (i === 1) return { ...row, temp: "38.5" };
      return row;
    });
    const judgement = judgeS5Submission(table(rows));
    expect(judgement.outcome).toBe("reject");
    if (judgement.outcome !== "reject") return;
    expect(judgement.reasons.map(({ reason }) => reason)).toEqual(["fullwidth", "date", "temp"]);
    expect(stage5SubmissionRejectLines(judgement.reasons)).toHaveLength(4);
  });

  it("不足の差し戻しにも提出本文の氏名を写さない", () => {
    const judgement = judgeS5Submission(`${stage5Patient.name}\t005`);
    expect(judgement.outcome).toBe("reject");
    expect(containsPii(judgement)).toBe(false);
  });

  it("#221で変更: IDの不足と整形の不備は同時に返し、IDの不足を先に並べる", () => {
    const rows = withRow(0, { date: "８月３日" }).filter((row) => row.id !== "030");
    expect(judgeS5Submission(table(rows))).toEqual(
      reject({ reason: "ids", missingIds: ["030"] }, { reason: "fullwidth" }, { reason: "date" }),
    );
  });

  describe("全角数字", () => {
    it("データ行に全角数字が残っていれば差し戻す", () => {
      expect(judgeS5Submission(table(withRow(3, { temp: "３８.６℃" })))).toEqual(
        reject({ reason: "fullwidth" }),
      );
    });

    it("前置きの全角数字は見ない", () => {
      expect(judgeS5Submission(`１４名分です\n${table(cleanRows())}`)).toEqual({
        outcome: "pass",
      });
    });

    it("#221で変更: 全角数字と日付の不揃いは同時に返し、全角数字を先に並べる", () => {
      expect(judgeS5Submission(table(withRow(0, { date: "8/1", temp: "３８.１℃" })))).toEqual(
        reject({ reason: "fullwidth" }, { reason: "date" }),
      );
    });
  });

  describe("日付の書き方", () => {
    it.each([
      ["M/D", "8/1"],
      ["和暦", "R8.8.1"],
      ["M月D日", "8月1日"],
      ["年つきM月D日", "2026年8月1日"],
      ["ISOスラッシュ", "2026/08/01"],
      ["M-D", "8-1"],
      ["M.D", "8.1"],
      // Two-digit month or day: a scan that only took one digit would miss these.
      ["M月D日（2桁の月）", "12月1日"],
      ["M月D日（2桁の日）", "8月12日"],
      ["M-D（2桁の月）", "12-5"],
      ["M-D（2桁の日）", "8-12"],
      ["M.D（2桁の月）", "12.5"],
      ["M.D（2桁の日）", "8.12"],
    ])("ISOと%sが混ざれば差し戻す", (_label, date) => {
      expect(judgeS5Submission(table(withRow(5, { date })))).toEqual(reject({ reason: "date" }));
    });

    // Each pair is one style the scan could collapse into the other if it misread the first.
    it.each([
      ["ISOスラッシュとM/D", "2026/08/01", "8/2"],
      ["和暦とM.D", "R8.8.1", "8.2"],
      ["和暦（/区切り）とM/D", "R8/8/5", "8/2"],
    ])("%sが混ざれば差し戻す", (_label, first, second) => {
      const rows = cleanRows().map((row, i) => ({ ...row, date: i === 0 ? first : second }));
      expect(judgeS5Submission(table(rows))).toEqual(reject({ reason: "date" }));
    });

    it("和暦は元号の年・月・日が2桁でも、区切りが.と/で混ざっても1種類と数える", () => {
      const dates = ["R10.8.1", "R8.10.2", "R8.8.10", "R8/8/5", "H30.1.2", "R8.8/6"];
      const rows = cleanRows().map((row, i) => ({ ...row, date: dates[i % dates.length] ?? "" }));
      expect(judgeS5Submission(table(rows))).toEqual({ outcome: "pass" });
    });

    it.each([
      ["M/D", (d: number) => `8/${String(d)}`],
      ["和暦", (d: number) => `R8.8.${String(d)}`],
      ["M月D日", (d: number) => `8月${String(d)}日`],
    ])("すべて%sで揃っていれば合格する（どの書式かは問わない）", (_label, format) => {
      const rows = cleanRows().map((row, i) => ({ ...row, date: format(i + 1) }));
      expect(judgeS5Submission(table(rows))).toEqual({ outcome: "pass" });
    });

    it.each([
      ["月が13", "13/1"],
      ["月が0", "0/5"],
      ["日が32", "8/32"],
      ["日が0", "8/0"],
    ])("%sの日付らしい語は日付として数えない", (_label, date) => {
      expect(judgeS5Submission(table(withRow(0, { date })))).toEqual({ outcome: "pass" });
    });

    it.each([
      ["月が12・日が31", "12/31"],
      ["月が1・日が1", "1/1"],
    ])("境界の%sは日付として数える", (_label, date) => {
      expect(judgeS5Submission(table(withRow(0, { date })))).toEqual(reject({ reason: "date" }));
    });

    it("体温の小数（38.6）をM.Dと読まない", () => {
      const rows = cleanRows().map((row) => ({ ...row, date: `8.${row.id.slice(1)}` }));
      // 8.05 etc. are two-digit days: M.D style. Temperatures 38.x must not add a second style.
      expect(judgeS5Submission(table(rows))).toEqual({ outcome: "pass" });
    });

    it("長い数値列の途中から日付を切り出さない", () => {
      expect(judgeS5Submission(table(withRow(0, { ward: "12345/678" })))).toEqual({
        outcome: "pass",
      });
    });
  });

  describe("体温の単位", () => {
    it("単位ありと単位なしが混ざれば差し戻す", () => {
      expect(judgeS5Submission(table(withRow(2, { temp: "38.2" })))).toEqual(
        reject({ reason: "temp" }),
      );
    });

    it.each(["38.2°C", "38.2゜C", "38.2度", "38.2 ℃", "38.2　℃"])(
      "%sは℃と同じ「単位あり」として扱う",
      (temp) => {
        expect(judgeS5Submission(table(withRow(2, { temp })))).toEqual({ outcome: "pass" });
      },
    );

    it("すべて単位なしで揃っていれば合格する", () => {
      const rows = cleanRows().map((row) => ({ ...row, temp: row.temp.replace("℃", "") }));
      expect(judgeS5Submission(table(rows))).toEqual({ outcome: "pass" });
    });

    it("空欄の体温はどちらにも数えない", () => {
      expect(judgeS5Submission(table(withRow(6, { temp: "" })))).toEqual({ outcome: "pass" });
    });

    it.each([
      ["37.0", true],
      ["40.9", true],
      ["36.9", false],
      ["41.0", false],
      ["38.12", false],
      ["39", false],
    ])("%sを体温とみなすか: %s", (temp, counted) => {
      const judgement = judgeS5Submission(table(withRow(4, { temp })));
      expect(judgement).toEqual(counted ? reject({ reason: "temp" }) : { outcome: "pass" });
    });

    it("#221で変更: 日付の不揃いと単位の混在は同時に返し、日付を先に並べる", () => {
      expect(judgeS5Submission(table(withRow(1, { date: "8/2", temp: "38.2" })))).toEqual(
        reject({ reason: "date" }, { reason: "temp" }),
      );
    });
  });

  describe("整形チェックの対象行", () => {
    it("区切りが1箇所しかない行は整形チェックの対象にしない", () => {
      const rows = cleanRows();
      const text = `${table(rows)}\n005\t8/1`;
      expect(judgeS5Submission(text)).toEqual({ outcome: "pass" });
    });

    it("区切りがちょうど2箇所（3列）の行は整形チェックの対象にする", () => {
      const text = `${table(cleanRows())}\n005\t8/1\t38.1℃`;
      expect(judgeS5Submission(text)).toEqual(reject({ reason: "date" }));
    });

    it("緩い区切りでも、連続する空白は1箇所と数える", () => {
      const text = `${table(cleanRows().slice(0, 13))}\n030  8/1`;
      expect(judgeS5Submission(text)).toEqual({ outcome: "pass" });
    });

    it("タブ区切りの行が14行あれば、空白1つ区切りの行は対象にしない", () => {
      const text = `${table(cleanRows())}\n005 5A 8/1 38.1`;
      expect(judgeS5Submission(text)).toEqual({ outcome: "pass" });
    });

    it("タブ区切りの行が13行なら、空白1つ区切りの行まで拾って検査する", () => {
      const rows = cleanRows();
      const text = `${table(rows.slice(0, 13))}\n030 5A 8/1 38.1℃`;
      expect(judgeS5Submission(text)).toEqual(reject({ reason: "date" }));
    });

    it("汚い一覧のタブを空白1つへ潰して貼っても素通りさせない", () => {
      const rows = withRow(0, { date: "7/3" });
      expect(judgeS5Submission(table(rows, " "))).toEqual(reject({ reason: "date" }));
    });

    it("IDを含まない行は整形チェックの対象にしない", () => {
      const text = `${table(cleanRows())}\n備考\t8/1\t38.1`;
      expect(judgeS5Submission(text)).toEqual({ outcome: "pass" });
    });

    it("IDが長い数値の一部なら、その行は対象にしない", () => {
      const text = `${table(cleanRows())}\n10050\t8/1\t38.1`;
      expect(judgeS5Submission(text)).toEqual({ outcome: "pass" });
    });
  });

  describe("#221: 見つかった誤りをすべて返す", () => {
    /** One row per mistake, so each can be switched on alone. */
    const mistakes = {
      ids: (rows: Row[]) => rows.filter((row) => row.id !== "030"),
      fullwidth: (rows: Row[]) => rows.map((row, i) => (i === 3 ? { ...row, ward: "５A" } : row)),
      date: (rows: Row[]) => rows.map((row, i) => (i === 5 ? { ...row, date: "8/6" } : row)),
      temp: (rows: Row[]) => rows.map((row, i) => (i === 7 ? { ...row, temp: "38.7" } : row)),
    } as const;
    const expected: Record<keyof typeof mistakes, S5RejectReason> = {
      ids: { reason: "ids", missingIds: ["030"] },
      fullwidth: { reason: "fullwidth" },
      date: { reason: "date" },
      temp: { reason: "temp" },
    };
    const order = ["ids", "fullwidth", "date", "temp"] as const;
    /** Every non-empty subset of the four mistakes: 4 alone, 6 pairs, 4 triples, all four. */
    const subsets = Array.from({ length: 15 }, (_, n) =>
      order.filter((_key, bit) => ((n + 1) & (1 << bit)) !== 0),
    );

    it.each(subsets.map((keys) => [keys.join("+"), keys] as const))(
      "%sの誤りを入れると、そのすべてをこの順で返す",
      (_label, keys) => {
        const rows = keys.reduce((acc, key) => mistakes[key](acc), cleanRows());
        const [first, ...rest] = keys.map((key) => expected[key]);
        expect(first).toBeDefined();
        if (first !== undefined)
          expect(judgeS5Submission(table(rows))).toEqual(reject(first, ...rest));
      },
    );

    it("前提: 表の形が読めない提出（IDの羅列だけ）はIDの不足だけを返す", () => {
      expect(judgeS5Submission("005 ８月３日\n006\t8/1\n008")).toEqual(
        reject({ reason: "ids", missingIds: S5_FEVER_IDS.slice(3) }),
      );
    });

    it("前提: 全14名分が欠けていれば整形は見ない（データ行が無い）", () => {
      expect(judgeS5Submission("８月３日と8/1と38.1と38.2℃")).toEqual(
        reject({ reason: "ids", missingIds: [...S5_FEVER_IDS] }),
      );
    });

    it("前提: IDが欠けたタブ区切りの表では、空白1つ区切りの前置きを整形チェックへ拾わない", () => {
      const rows = mistakes.ids(cleanRows());
      const text = `以下 １３名分 です（005〜027） 8/1\n${table(rows)}`;
      expect(judgeS5Submission(text)).toEqual(reject({ reason: "ids", missingIds: ["030"] }));
    });

    it("前提: IDが欠けていても表が空白1つ区切りなら、残りの行の書式を見る", () => {
      const rows = mistakes.date(mistakes.ids(cleanRows()));
      expect(judgeS5Submission(table(rows, " "))).toEqual(
        reject({ reason: "ids", missingIds: ["030"] }, { reason: "date" }),
      );
    });

    it("全角の日付は、半角に直した後の書き方で日付の不揃いも同時に返す", () => {
      expect(judgeS5Submission(table(withRow(0, { date: "８月１日" })))).toEqual(
        reject({ reason: "fullwidth" }, { reason: "date" }),
      );
    });

    it("全角の日付がISOで書かれていれば、全角数字だけを返す（日付は揃っている）", () => {
      expect(judgeS5Submission(table(withRow(0, { date: "２０２６-０８-０１" })))).toEqual(
        reject({ reason: "fullwidth" }),
      );
    });

    it("全角の体温に単位が無ければ、単位の混在も同時に返す", () => {
      expect(judgeS5Submission(table(withRow(2, { temp: "３８.２" })))).toEqual(
        reject({ reason: "fullwidth" }, { reason: "temp" }),
      );
    });

    it("全角の体温に単位が付いていれば、全角数字だけを返す（教材の008の行）", () => {
      expect(judgeS5Submission(table(withRow(2, { temp: "３８.２℃" })))).toEqual(
        reject({ reason: "fullwidth" }),
      );
    });

    it("理由には提出本文を写さない", () => {
      const rows = mistakes.date(mistakes.ids(withRow(0, { ward: stage5Patient.name })));
      const judgement = judgeS5Submission(table(rows));
      expect(judgement.outcome).toBe("reject");
      expect(containsPii(judgement)).toBe(false);
    });
  });

  it("判定の結果はtoStageJudgementでrecord-judgementへ包める（理由は落ちる）", () => {
    const allFour = table(
      withRow(3, { ward: "５A", date: "8/4", temp: "38.3" }).filter((row) => row.id !== "030"),
    );
    for (const text of ["", table(cleanRows()), table(withRow(0, { temp: "38.1" })), allFour]) {
      const judgement = judgeS5Submission(text);
      expect(toStageJudgement(judgement)).toEqual({ outcome: judgement.outcome });
      expect(wrap(judgement).success).toBe(true);
    }
  });
});
