import {
  stage2AddendumSheetText,
  stage2SheetText,
  stage5ChartPatient,
  stage5FeverRows,
  stage5FeverSheetText,
  viewerDocs,
} from "@hell-ict/content";
import { describe, expect, it } from "vitest";

import {
  containsPii,
  detectPii,
  PII_REDACTION,
  piiPatterns,
  redactPii,
  stage5Patient,
} from "../src/pii.js";

/** The chart's date of birth ("YYYY年M月D日"), split into its parts. */
const DOB = (() => {
  const [, year = "", month = "", day = ""] =
    /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(stage5ChartPatient.dob) ?? [];
  return { year, month, day };
})();

const pad = (value: string): string => value.padStart(2, "0");

describe("送信前PIIゲート", () => {
  // The name and ID come from content's first fever-list row; the rest from the chart.
  it("カルテの患者は発熱患者一覧の先頭行と同一人物で、残りはカルテの固有情報", () => {
    const [first] = stage5FeverRows;
    expect(stage5Patient).toEqual({ name: first.name, id: first.id, ...stage5ChartPatient });
  });

  it.each([
    ["患者氏名", `${stage5Patient.name}さんについて教えてください`],
    ["生年月日", `${stage5Patient.dob}生まれの方です`],
    ["電話番号", `連絡先は${stage5Patient.phone}です`],
    ["ご家族の氏名", `ご長男の${stage5Patient.familyName}様より`],
  ])("%sを検知する", (label, text) => {
    expect(detectPii(text)).toBe(label);
  });

  it.each([
    stage5Patient.name.replace(" ", "\u3000"),
    stage5Patient.name.replace(" ", ""),
    stage5Patient.name.replace(" ", "  "),
  ])("氏名の表記ゆれ「%s」も検知する", (variant) => {
    expect(detectPii(`${variant}さんの件です`)).toBe("患者氏名");
  });

  // 2026-08-22 ユーザー決定: 院内ID単独はPII扱いしない（匿名化済みのStage 2
  // ラインリストが患者IDだけを含み、素の数字にゲートが誤射していたため）。
  // ラベル付き「患者ID: 005」であっても、氏名・生年月日など直接識別子を
  // 伴わない限り検知しない。
  it.each([
    `患者ID ${stage5Patient.id} の件です`,
    `患者ID: ${stage5Patient.id}`,
    stage5Patient.id,
    "患者ID 006・008の3名です",
  ])("院内ID単独「%s」は検知しない", (text) => {
    expect(detectPii(text)).toBeNull();
  });

  it("正しく匿名化した依頼は誤爆しない", () => {
    expect(detectPii("5A病棟の70代男性のご家族へ、面会制限の説明文を作成してください")).toBeNull();
    expect(detectPii("原因不明の発熱について、ご家族向けの説明文をお願いします")).toBeNull();
  });

  it("Stage 2のラインリスト行相当（患者ID・病棟・採取日・結果のみ、氏名列なし）は誤爆しない", () => {
    expect(detectPii("005\t5A\t7.3\t陰性\t37.9℃\tなし")).toBeNull();
    expect(detectPii("006\t5A\t7.4\t陰性\t38.0℃\tなし")).toBeNull();
    expect(detectPii("008\t5B\t7.5\t陰性\t37.8℃\tあり")).toBeNull();
  });

  // 2026-08-22 モック側S5_PII検証で発見: 電話番号regexの区切りに`\s`（改行を含む）
  // を使うと、改行区切りの数値列（Stage 4正解経路でAIに渡す発熱患者ID一覧）が
  // 電話番号として誤検知されてしまう。区切りを半角ハイフン・半角スペース・
  // 全角スペース（U+3000）のみへ絞ったことの回帰確認。
  it("改行区切りのID一覧（14行）は電話番号として誤爆しない", () => {
    const idList = stage5FeverRows.map((row) => row.id);
    expect(idList).toHaveLength(14);
    expect(detectPii(idList.join("\n"))).toBeNull();
  });

  it.each(["090-0000-5678", "090 0000 5678", "090\u30000000\u30005678"])(
    "実際の電話番号形式「%s」は引き続き検知する",
    (phone) => {
      expect(detectPii(`連絡先は${phone}です`)).toBe("電話番号");
    },
  );

  // 区切り無し（携帯11桁・固定電話10桁）と、市外局番2桁の固定電話も引き続き拾う。
  // 末尾の加入者番号を4桁固定にした修正（pii.ts §piiPatterns 制約3）の巻き添えが
  // 無いことの確認。
  it.each(["09000005678", "03-1234-5678", "0312345678", "0857-32-1234"])(
    "区切り無し・固定電話の電話番号「%s」も検知する",
    (phone) => {
      expect(detectPii(`連絡先は${phone}です`)).toBe("電話番号");
    },
  );

  // 2026-08-22 実測: 旧パターン（末尾`\d{3,4}`・数字境界なし）は、スペース区切りの
  // ID列「005 006 008」を「0＋05／006／008」の電話番号として拾っていた。Stage 4の
  // 正解経路（氏名列を落としたID列をAIへ渡す）で罰が誤爆する。タブ・カンマ・読点・
  // 中黒区切りでも同じく通ることを確認する。
  it.each([
    "005 006 008",
    "005 006 008 011 013",
    "005 006 008 011 013 015 017 019 021 024 027 030",
    "005\t006\t008\t011",
    "005,006,008,011",
    "005、006、008",
    "005・006・008",
    "患者ID 005 006 008 の並びを整えてください",
  ])("スペース等で区切ったID列「%s」は電話番号として誤爆しない", (text) => {
    expect(detectPii(text)).toBeNull();
  });

  // 2026-08-22 実測: 旧パターン（汎用の`\d{4}年\d{1,2}月\d{1,2}日`）は、研修当日の
  // 日付を書いただけの依頼をブロックしていた。生年月日の検知は教材の値
  // （stage5Patient.dob）だけを情報源にする。
  it.each([
    "2026年8月22日の研修内容をまとめて",
    "2026年8月23日の報告をまとめて",
    "2026年7月30日に発熱を確認しました",
    "2026-08-22の一覧を整えてください",
    `${DOB.year}年${DOB.month}月${String(Number(DOB.day) + 1)}日`,
    `${String(Number(DOB.year) + 1)}年${DOB.month}月${DOB.day}日`,
    `${DOB.year}/${DOB.month}/${DOB.day}0`,
  ])("教材の生年月日でない日付「%s」は検知しない", (text) => {
    expect(detectPii(text)).toBeNull();
  });

  it.each([
    `${DOB.year}年${DOB.month}月${DOB.day}日`,
    `${DOB.year}年${pad(DOB.month)}月${pad(DOB.day)}日`,
    `${DOB.year}/${DOB.month}/${DOB.day}`,
    `${DOB.year}/${pad(DOB.month)}/${pad(DOB.day)}`,
    `${DOB.year}-${pad(DOB.month)}-${pad(DOB.day)}`,
    `${DOB.year}.${DOB.month}.${DOB.day}`,
  ])("教材の生年月日の表記ゆれ「%s」は検知する", (dob) => {
    expect(detectPii(`${dob}生まれの方です`)).toBe("生年月日");
  });

  it("空入力・非該当の数値・日付表記を誤爆しない", () => {
    expect(detectPii("")).toBeNull();
    expect(detectPii("0050")).toBeNull();
    expect(detectPii("1005")).toBeNull();
    expect(detectPii("37.9℃")).toBeNull();
    expect(detectPii("7/10")).toBeNull();
  });

  it("同じ入力を繰り返し判定しても結果が変わらない", () => {
    const text = `${stage5Patient.name}さんの件です`;
    expect(detectPii(text)).toBe("患者氏名");
    expect(detectPii(text)).toBe("患者氏名");
  });

  it("複数該当時はパターン順で先に定義したラベルを返す", () => {
    const text = `${stage5Patient.name}さん（${stage5Patient.dob}生）の件です`;
    expect(detectPii(text)).toBe("患者氏名");
  });

  // Stage 4のカルテ本文はID単独ではなく、氏名・生年月日を同じ文中に含むため、
  // ID検知を外しても実際の漏洩シナリオは引き続き検知される（回帰確認）。
  it("Stage 4カルテの経過欄相当（ID＋氏名＋生年月日が同居する文）は引き続き検知する", () => {
    const text = `7/3 患者ID ${stage5Patient.id}、${stage5Patient.name}さん（${stage5Patient.dob}生、74歳）が受診。`;
    expect(detectPii(text)).toBe("患者氏名");
  });
});

describe("画面の教材と送信前ゲート", () => {
  // 検知リスト（pii.ts の feverLinelistPatientNames）は content の stage5FeverRows から
  // 組み立てるが、公開されていないので、それを選言にした正規表現から氏名を読み戻して
  // 比べる。組み立てが崩れて1名でも落ちれば、その1名だけがゲートをすり抜ける。
  it("発熱患者一覧の14名の氏名は送信前ゲートの検知リストと過不足なく一致する", () => {
    const namePattern = piiPatterns.find((pattern) => pattern.label === "患者氏名");
    const detectable = (namePattern?.re.source ?? "")
      .split("|")
      .map((name) => name.replace("\\s*", " "));

    expect([...detectable].sort()).toEqual(stage5FeverRows.map((row) => row.name).sort());
  });

  it("発熱患者一覧の全員の氏名が、姓名の空白の有無にかかわらず送信前ゲートで止まる", () => {
    expect(stage5FeverRows.every(({ name }) => name.length > 0)).toBe(true);
    for (const { name } of stage5FeverRows) {
      expect(detectPii(`${name}さん`)).toBe("患者氏名");
      expect(detectPii(`${name.replace(/\s/gu, "")}さん`)).toBe("患者氏名");
    }
  });

  // 一覧を丸ごと貼る（＝Stage 5 の罠そのもの）とゲートが必ず止める。行単位でも
  // 見出しを除く1行残らず止まることまで見る。
  it("ビューアの発熱患者一覧を丸ごと貼っても行ごとに貼っても止まる（罠が生きている）", () => {
    expect(detectPii(stage5FeverSheetText)).toBe("患者氏名");
    expect(detectPii(viewerDocs.s5list.text)).toBe("患者氏名");
    const dataLines = stage5FeverSheetText.split("\n").slice(1);
    expect(dataLines).toHaveLength(stage5FeverRows.length);
    for (const line of dataLines) expect(detectPii(line)).toBe("患者氏名");
  });

  // Stage 2 のラインリストは匿名化教材（氏名列なし）。Stage 2 の正規タスクで AI に
  // 貼り付ける全文が、Stage 5 の検知パターンに誤射されない。
  it("Stage 2 のラインリスト（配布版・追加分）を丸ごと貼っても止まらない", () => {
    expect(detectPii(stage2SheetText)).toBeNull();
    expect(detectPii(stage2AddendumSheetText)).toBeNull();
  });
});

describe("containsPii", () => {
  it("PIIを含まないJSON値は素通しする", () => {
    expect(containsPii({})).toBe(false);
    expect(containsPii({ pos: 3, view: "s1", ok: true, none: null })).toBe(false);
    expect(containsPii([1, "メモ", { nested: ["配列", { deep: "値" }] }])).toBe(false);
    expect(containsPii("ただのテキスト")).toBe(false);
    expect(containsPii(42)).toBe(false);
    expect(containsPii(null)).toBe(false);
    expect(containsPii(undefined)).toBe(false);
  });

  it("入れ子の値に混ざったPIIを拾う", () => {
    expect(containsPii({ memo: `${stage5Patient.name}さんの件` })).toBe(true);
    expect(containsPii({ a: { b: { c: [`連絡先は${stage5Patient.phone}`] } } })).toBe(true);
    expect(containsPii([["深い配列", { dob: `${stage5Patient.dob}生まれ` }]])).toBe(true);
  });

  it("キーに置かれたPIIも拾う", () => {
    // 値ではなくキー側へ置く経路を塞ぐ（チェックポイントのdataはキーが自由文字列）。
    expect(containsPii({ [`${stage5Patient.name}さん`]: 1 })).toBe(true);
    expect(containsPii({ outer: { [stage5Patient.phone]: "x" } })).toBe(true);
  });

  it("1つの値に収まったPIIも、分割されたJSON全体の並びも見る", () => {
    // 個別の値だけを見るのでは足りず、JSON全体だけを見るのでも足りないので両方掛ける。
    expect(containsPii({ text: `${stage5Patient.name}さん` })).toBe(true);
    expect(containsPii([`${stage5Patient.familyName}様`])).toBe(true);
  });

  it("文字列以外のプリミティブはそれ自体では反応しない", () => {
    expect(containsPii(true)).toBe(false);
    expect(containsPii([1, 2, 3])).toBe(false);
  });

  it("深く入れ子になった値も最下層まで辿る", () => {
    // 深さの上限は呼び出し側の責務（チェックポイントはschemaのCHECKPOINT_DATA_MAX_DEPTH、
    // 活動ログのmetaは平坦なrecord）。ここではその範囲を十分に超える深さでも
    // 最下層まで届くことだけを固定する。
    const deep = Array.from({ length: 20 }).reduce<unknown>((inner) => ({ nested: inner }), {
      memo: `${stage5Patient.name}さん`,
    });
    expect(containsPii(deep)).toBe(true);
  });
});

describe("redactPii", () => {
  it("PIIを含まないテキストはそのまま返す", () => {
    expect(redactPii("ただのメモです")).toBe("ただのメモです");
    expect(redactPii("")).toBe("");
  });

  it("既知のパターンを伏せ字へ置き換える", () => {
    const redacted = redactPii(`${stage5Patient.name}さんの件`);
    expect(redacted).not.toContain(stage5Patient.name);
    expect(redacted).toContain(PII_REDACTION);
    expect(redacted).toContain("さんの件");
  });

  it("同じ本文に複数回出てきても全部置き換える", () => {
    const redacted = redactPii(
      `${stage5Patient.name}さんと${stage5Patient.name}さん、連絡先は${stage5Patient.phone}`,
    );
    expect(detectPii(redacted)).toBeNull();
  });

  it("置換後のテキストはdetectPiiに反応しない", () => {
    for (const source of [
      `${stage5Patient.name}さんについて`,
      `${stage5Patient.dob}生まれの方です`,
      `連絡先は${stage5Patient.phone}です`,
      `ご長男の${stage5Patient.familyName}様より`,
    ]) {
      expect(detectPii(redactPii(source)), source).toBeNull();
    }
  });
});
