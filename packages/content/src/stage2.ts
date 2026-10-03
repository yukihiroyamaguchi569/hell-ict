import type { Lines, Mail, SheetRow } from "./schemas.js";

/*
 * Stage 2（火の手）の文言と教材。モック hell-ict-archive:docs/ui/mock/index.html の写し。
 * 表教材はこのファイルの stage2SheetRows（と stage2AddendumRows）が正典。
 * 設計用の annotated 版（伏線3名に ★）は絶対に持ち込まない。
 * 締切（S2_DEADLINE）・苅部さんの待ち時間（S2_KARUBE_DELAY）・期待行数は時間処理・判定の側が持つ。
 */

/** 5A病棟師長の依頼（モック MAIL_S1）。添付がグリッドの初期値（ビューア main）。 */
export const stage2Mail = {
  from: "5A病棟 師長",
  subj: "至急！！MRSAのやつまとめて",
  attach: "5A病棟_MRSA_記録_最新版(2)_コピー.xlsx",
  body: [
    "新しいICTの方ですよね。悪いけど急ぎで。",
    "5A病棟でMRSA疑いが出てます。とりあえず手元の記録、そのままのExcelで送ります。",
    "これ、感染対策の会議で使える形にキレイにまとめてください。日付とかバラバラですみません、私が作ったんじゃないので。",
    "7時の申し送りまでに流行曲線の材料も要るそうです。よろしく！",
  ],
} as const satisfies Mail;

/** 締切超過で着弾する追加分（モック MAIL_S1_ADD）。罠ではないので暗転も警報も出さない。 */
export const stage2AddendumMail = {
  from: "5A病棟 師長",
  subj: "すみません追加で",
  attach: "5A病棟_MRSA_記録_最新版(2)_コピー_追加分.xlsx",
  body: ["あ、ごめんなさい。副師長が別につけてた分が出てきました。これも一緒にお願いします。"],
} as const satisfies Mail;

/** クリア後に届く師長の返信（モック MAIL_UNLOCK）。 */
export const stage2ClearMail = {
  from: "5A病棟 師長",
  subj: "Re: 至急！！MRSAのやつまとめて",
  body: ["え、もう？　…助かる。あなた達、話が早いわね。"],
} as const satisfies Mail;

/** グリッドの列見出し（モック S2_COLS）。氏名列は削除済み——Stage 4 の PII 検知に誤射されるため。 */
export const stage2Columns = [
  "患者ID",
  "病棟",
  "採取日",
  "MRSA結果",
  "発熱",
  "備考",
] as const satisfies SheetRow;

/** 元ファイルの汚れた見出し行（モック S2_HEAD_DIRTY）。ビューアの表示にだけ現れる。 */
export const stage2DirtyHeader = [
  "患者ＩＤ",
  "びょうとう",
  "採取日",
  "MRSA",
  "発熱",
  "メモ",
] as const satisfies SheetRow;

/** 配布版のラインリスト22行（モック S2_SHEET_ROWS）。1列目だけに値がある2行はノイズ行（参加者が削除する）。 */
export const stage2SheetRows = [
  ["5A病棟の状況　7月分", "", "", "", "", ""],
  ["００１", "5A病棟", "7/3", "陽性", "あり", "個室へ"],
  ["id-2", "", "7月3日", "(+)", "38.2℃", ""],
  ["no.3", "", "R8.7.3", "ポジ", "なし", ""],
  ["４番", "", "さんにち", "＋", "あり", "家族面会あり"],
  ["005", "5A", "7.3", "陰性", "37.9℃", ""],
  ["6", "", "2026/07/04", "－", "あり", ""],
  ["007", "5A病棟", "7/4", "陰性", "なし", ""],
  ["008", "", "７月４日", "ネガ", "38.5℃", ""],
  ["", "", "", "", "", ""],
  ["009", "5A", "7/5", "陽性", "あり", "接触者調査中"],
  ["10", "", "7-5", "(+)", "なし", ""],
  ["No.011", "５Ａ", "R8/7/5", "陰性", "なし", ""],
  ["０１２", "", "7月6日", "ポジ", "38.0℃", "個室へ"],
  ["id-13", "5a", "7/6", "＋", "あり", ""],
  ["14", "", "7-6", "陰性", "なし", ""],
  ["015", "5A病棟", "2026/07/06", "(-)", "なし", ""],
  ["１６", "", "7.7", "陽性", "あり", "個室へ"],
  ["no.17", "5A", "７月７日", "ネガ", "なし", ""],
  ["018", "", "7/7", "陰性", "なし", ""],
  ["19番", "5A病棟", "R8.7.8", "－", "なし", ""],
  ["０２０", "", "7/8", "＋", "38.1℃", "接触者調査中"],
] as const satisfies readonly SheetRow[];

/** 締切超過で着弾する追加分10行（モック S2_ADDENDUM_ROWS）。伏線は1名も入れない。 */
export const stage2AddendumRows = [
  ["021", "5A病棟", "7/8", "陽性", "あり", ""],
  ["no.22", "", "R8.7.8", "(+)", "38.3℃", "個室へ"],
  ["０２３", "5A", "７月８日", "陰性", "なし", ""],
  ["24番", "", "7.8", "ネガ", "なし", ""],
  ["id-25", "５Ａ", "2026/07/09", "＋", "あり", "接触者調査中"],
  ["026", "", "7/9", "(-)", "なし", ""],
  ["２７", "5a", "7-9", "陽性", "38.7℃", "個室へ"],
  ["no.28", "", "R8/7/9", "－", "なし", ""],
  ["029", "5A病棟", "7月9日", "ポジ", "あり", ""],
  ["０３０", "", "7/10", "陰性", "なし", "退院予定"],
] as const satisfies readonly SheetRow[];

/* ビューアの表示幅。全角は2セル分の幅を取るので、表示幅で桁を揃える（モック WIDE・COLW）。 */
const WIDE_CHAR =
  /[\u1100-\u115F\u2103\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u;
const COLUMN_WIDTHS = [10, 12, 13, 7, 9, 0] as const;

// コードポイント単位で数える（モック dispW と同じ。教材に結合文字・絵文字は無い）。
const displayWidth = (text: string): number =>
  Array.from(text).reduce((width, char) => width + (WIDE_CHAR.test(char) ? 2 : 1), 0);

const padToWidth = (text: string, width: number): string =>
  text + " ".repeat(Math.max(1, width - displayWidth(text)));

const isNoiseRow = (row: SheetRow): boolean => row.slice(1).every((cell) => cell === "");

const formatSheetLine = (row: SheetRow): string =>
  isNoiseRow(row)
    ? row[0]
    : row
        .map((cell, index) => {
          const width = COLUMN_WIDTHS[index] ?? 0;
          return width === 0 ? cell : padToWidth(cell, width);
        })
        .join("")
        .trimEnd();

/**
 * 添付ビューアに出すラインリストの本文（モック sheetText）。グリッドと同じ行から
 * 組み立てる——2か所に別々の教材を持つと、片方だけ直る事故になる。
 * 元ファイルの見出し行は、採取日（常に埋まっている3列目）を持つ最初の行の前に、
 * 空行を挟んで差し込む。
 */
export const formatStage2Sheet = (rows: readonly SheetRow[]): string => {
  const lines = rows.map(formatSheetLine);
  const firstDataRow = rows.findIndex((row) => row[2] !== "");
  lines.splice(
    firstDataRow < 0 ? lines.length : firstDataRow,
    0,
    "",
    formatSheetLine(stage2DirtyHeader),
  );
  return lines.join("\n");
};

/** 配布版の本文（モック SHEET）。ビューア main。 */
export const stage2SheetText = formatStage2Sheet(stage2SheetRows);

/** 追加分の本文（モック SHEET_ADD）。ビューア add。 */
export const stage2AddendumSheetText = formatStage2Sheet(stage2AddendumRows);

/** AIパネルを解禁する苅部さんの着信（モック PHS_LINES）。 */
export const stage2KarubeLines = [
  "〔苅部〕また師長のExcelですか。あれ、日付の書き方が5種類くらいありますよね。",
  "〔苅部〕そういうの、手で直すもんじゃないですよ。今、そっちのAI、オンにします。",
  "〔苅部〕……はい、出ました。右のパネルです。使ってみてください。",
] as const satisfies Lines;

/** Stage 2 の台本応答（整形済みの表）の前に置く一文（モック S2_SCRIPTED_LEAD）。表そのものは判定の模範解答から組み立てるので domain 側。 */
export const stage2ScriptedLead = "整形しました。「表に送る」で提出する表に入ります。";

/**
 * グリッドへ貼った複数行が表として読めない（区切りが無い）ときの理由（モック S2_PASTE_NO_DELIM）。
 * AI の返しをそのまま貼って詰まる経路なので、AI への言い直し方まで書く。
 */
export const stage2PasteNoDelimiter =
  "表として読めません（タブ・カンマ・|の区切りが必要です）。AIへ「タブ区切りの表で出してください」と指定し直してみてください。";

/** 貼り付け・［表に送る］の表が壊れていたときの残りの理由（モック parseTable の error）。 */
export const stage2PasteErrors = {
  unclosedQuote: "引用符が閉じていません",
  tooManyColumns: (columns: number, row: number): string =>
    `列が${String(columns)}つを超えています（${String(row)}行目）`,
} as const;

/** 台本応答の表をグリッドへ流し込むボタン（モック sendAI の .to-grid）。 */
export const stage2SendToGrid = "表に送る";

/** 課題文（モック renderStage2Excel の .brief）。正規化ルールの表は出さない——要件の言語化そのものが学習目標。 */
export const stage2Brief = "流行曲線が描けるよう、各列の書き方を統一して提出せよ。";

/** 手作業の画面の固定の文言（モック renderStage2Excel・drawGrid・runVerdict・#btn-take）。 */
export const stage2WorkText = {
  submitHeading: "提出",
  openAttachment: "添付を開く",
  reset: "最初の状態に戻す",
  resetConfirm: "グリッドを最初の状態に戻します。よろしいですか？",
  submit: "提出する",
  reopen: "提出に戻る",
  /** 畳んだ提出フォームの一行（モック runVerdict の #folded-t）。 */
  submitted: (size: string): string => `提出しました${IDEOGRAPHIC_SPACE}${size}`,
  addRow: "＋ 行を追加",
  deleteRow: "この行を削除",
  take: "表に追加",
} as const;

/** 提出前に誰でも数えられる表の大きさ（モック updateRecog）。 */
export const stage2GridSize = (rows: number, columns: number): string =>
  `${String(rows)}行 × ${String(columns)}列`;

/** 判定の4項目（モック runVerdict の CHECKS）。行数は追加分の着弾で 20 から 30 に変わる。 */
export const stage2CheckLabels = {
  requiredCells: "必須列がすべて埋まっている",
  collectionDate: "採取日が YYYY-MM-DD に統一",
  mrsaResult: "MRSA結果が 陽性/陰性 の2値",
  rowCount: (expected: number): string => `行数が${String(expected)}行`,
} as const;

/**
 * 差し戻しの理由（モック checkGrid の why）。「形式が不正です」で突き放さず件数を言い、
 * 場所はグリッドのセルを光らせて指す。
 */
export const stage2RejectReasons = {
  requiredCells: (count: number): string => `${String(count)}件の空欄が残っています`,
  collectionDate: (count: number): string => `${String(count)}件が YYYY-MM-DD になっていません`,
  mrsaResult: (count: number): string => `${String(count)}件残っています（下で光っている分）`,
  addendumNotTaken: (rows: number): string =>
    `追加分${String(rows)}行がまだ表に入っていません（師長のメールの添付を開いて［表に追加］）`,
  countMismatch: (expected: number, actual: number): string =>
    `${String(expected)}行のはずが ${String(actual)}行です`,
} as const;

const IDEOGRAPHIC_SPACE = "　";

/** 判定の1行（モック runVerdict の .check）。落ちた項目の次の1項目は「中断しました」で止まる。 */
export const stage2CheckLine = {
  pass: (label: string): string => `✓ ${label}`,
  fail: (label: string, why: string): string => [`✗ ${label}`, `→ ${why}`].join(IDEOGRAPHIC_SPACE),
  halt: (label: string): string => `─ ${label} の確認は中断しました`,
} as const;

/** 差し戻しの最後の一行（モック runVerdict）。失敗ではなく差し戻し：罰も回数制限も無い。 */
export const stage2RetryLine = "直して、もう一度提出してください。回数の制限はありません。";

/** 合格の一行（モック runVerdict の .done）。 */
export const stage2ClearedText = "Stage 2 をクリアしました";

/**
 * 提出がサーバに届かなかった・読めない答えが返ったとき。モックはブラウザの中で判定したので
 * この場面が無く、モックに無い文言。
 */
export const stage2SubmitFailed = "提出を届けられませんでした。もう一度提出してください。";
