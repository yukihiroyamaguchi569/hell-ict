import type { FeverRow, Lines, Mail, ReportToken, ViewerTable } from "./schemas.js";
import { stage4SendFailed } from "./stage4.js";

/*
 * Stage 5（回答）の文言と教材。モック hell-ict-archive:docs/ui/mock/index.html の S5_* 定数の写し。
 * 表教材はこのファイルの stage5FeverRows が正典（氏名列を含む14名・罠の実体）。
 * 送信前ゲート（packages/domain/src/pii.ts）は14名の氏名をこの一覧から組み立てる。
 * 送信前ゲートの検知パターン（S5_PII）・提出判定・締切は domain 側が持つ。
 * 氏名・連絡先はすべて研修用のダミーで、外部へ送らない（AGENTS.md）。
 */

/** 事務長の依頼（モック MAIL_S5_JIMU）。添付が発熱患者一覧（ビューア s5list）。 */
export const stage5JimuMail = {
  from: "事務長",
  subj: "【至急】保健所への発熱患者一覧提出について",
  attach: "発熱患者一覧（未整理）.xlsx",
  body: [
    "保健所から、発熱患者の一覧を本日中に提出するよう要請が来ています。添付を整えて提出してください。",
    "各病棟から慌てて集めたものなので、表記がバラバラのままです。体裁よりも、今日中に出すことを優先してください。",
  ],
} as const satisfies Mail;

/** 発熱患者一覧14名（モック S5_FEVER_ROWS）。汚れは発熱確認日・最高体温・備考の3列だけ。 */
export const stage5FeverRows = [
  {
    id: "005",
    name: "青木 一郎",
    ward: "5A",
    date: "7/3",
    temp: "38.1℃",
    note: "",
  },
  {
    id: "006",
    name: "石川 和子",
    ward: "5B",
    date: "2026-07-30",
    temp: "38.4℃",
    note: "",
  },
  {
    id: "008",
    name: "上田 健",
    ward: "3B",
    date: "R8.8.1",
    temp: "３８.６℃",
    note: "精査中",
  },
  {
    id: "002",
    name: "江口 春美",
    ward: "5A",
    date: "7/28",
    temp: "38.0℃",
    note: "",
  },
  {
    id: "004",
    name: "岡本 正樹",
    ward: "6A",
    date: "7月29日",
    temp: "37.8",
    note: "解熱剤使用",
  },
  {
    id: "011",
    name: "片山 由美",
    ward: "5A",
    date: "8-2",
    temp: "38.2℃",
    note: "",
  },
  {
    id: "013",
    name: "北村 光",
    ward: "5A",
    date: "８月３日",
    temp: "",
    note: "家族への説明必要かも",
  },
  {
    id: "015",
    name: "久保 直子",
    ward: "5A",
    date: "2026/08/04",
    temp: "37.9",
    note: "検査結果待ち",
  },
  {
    id: "017",
    name: "小池 勉",
    ward: "5A",
    date: "R8/8/5",
    temp: "38.3℃",
    note: "",
  },
  {
    id: "019",
    name: "斉藤 智子",
    ward: "5A",
    date: "8.6",
    temp: "",
    note: "夜間に発熱あり、当直より報告",
  },
  {
    id: "021",
    name: "杉山 茂",
    ward: "5A",
    date: "8月7日",
    temp: "３８．５℃",
    note: "",
  },
  {
    id: "024",
    name: "高木 明美",
    ward: "6A",
    date: "2026-08-08",
    temp: "37.7℃",
    note: "解熱傾向、経過観察",
  },
  {
    id: "027",
    name: "千葉 翔",
    ward: "5A",
    date: "R8.8.9",
    temp: "39.0",
    note: "39℃超、要注意",
  },
  {
    id: "030",
    name: "中西 和美",
    ward: "5B",
    date: "8/10",
    temp: "38.1℃",
    note: "退院延期",
  },
] as const satisfies readonly FeverRow[];

/**
 * カルテの患者（発熱患者一覧の先頭行と同一人物）の、一覧に無い固有情報。
 * 送信前ゲート（packages/domain/src/pii.ts）の検知パターンはここから組み立てる。
 */
export const stage5ChartPatient = {
  dob: "1950年4月8日",
  phone: "090-0000-5678",
  familyName: "青木 次郎",
} as const;

/** 発熱患者一覧の列見出し（モック S5_FEVER_TABLE.header）。 */
export const stage5FeverColumns = [
  "患者ID",
  "氏名",
  "病棟",
  "発熱確認日",
  "最高体温",
  "備考",
] as const satisfies readonly string[];

/**
 * 列選択コピーのための表（モック S5_FEVER_TABLE）。表示用テキストと列コピーが
 * 別々の定義を持つと片方だけ直ってずれるので、行から組み立てる。
 */
export const stage5FeverTable = {
  header: stage5FeverColumns,
  rows: stage5FeverRows.map((row) => [row.id, row.name, row.ward, row.date, row.temp, row.note]),
} satisfies ViewerTable;

/** 添付ビューアに出す一覧（モック S5_FEVER_SHEET_TEXT）。見出し行つきのタブ区切り。 */
export const stage5FeverSheetText = [stage5FeverTable.header, ...stage5FeverTable.rows]
  .map((row) => row.join("\t"))
  .join("\n");

/** 罰ゲーム（黒塗り）のインシデント報告書の下書き（モック S5_REPORT）。pii: true は塗るべき語、false は塗ってはいけない一般語、無しはクリックできない地の文。連絡先・住所は実在しない値（example.com・架空の市名）。片ごとのリテラル型は使い道が無いので、as const ではなく型注釈で持つ。 */
export const stage5IncidentReport: readonly ReportToken[] = [
  {
    t: "【インシデント報告書（下書き）】\n",
  },
  {
    t: "発生日時：",
  },
  {
    t: "8月22日 16:40",
    pii: false,
  },
  {
    t: "　",
  },
  {
    t: "報告者：",
  },
  {
    t: "感染制御チーム",
    pii: false,
  },
  {
    t: "\n",
  },
  {
    t: "対象：",
  },
  {
    t: "保健所提出用・発熱患者一覧（14名分）",
    pii: false,
  },
  {
    t: "\n",
  },
  {
    t: "概要：",
  },
  {
    t: "5A",
    pii: false,
  },
  {
    t: "病棟の患者",
  },
  {
    t: "005",
    pii: false,
  },
  {
    t: "（発熱確認日",
  },
  {
    t: "7/3",
    pii: false,
  },
  {
    t: "・最高体温",
  },
  {
    t: "38.1℃",
    pii: false,
  },
  {
    t: "）をはじめとする14名分の一覧を、整形のためそのまま",
  },
  {
    t: "外部AIサービス",
    pii: false,
  },
  {
    t: "へ貼り付けようとした。送信は直前で遮断されたが、選択範囲には次が含まれていた。\n\n",
  },
  {
    t: "1. 氏名列（14名分）のうち：\n　",
  },
  {
    t: "青木 一郎",
    pii: true,
  },
  {
    t: "様　",
  },
  {
    t: "石川 和子",
    pii: true,
  },
  {
    t: "様　",
  },
  {
    t: "上田 健",
    pii: true,
  },
  {
    t: "様　",
  },
  {
    t: "江口 春美",
    pii: true,
  },
  {
    t: "様　",
  },
  {
    t: "岡本 正樹",
    pii: true,
  },
  {
    t: "様　",
  },
  {
    t: "片山 由美",
    pii: true,
  },
  {
    t: "様　",
  },
  {
    t: "北村 光",
    pii: true,
  },
  {
    t: "様　",
  },
  {
    t: "久保 直子",
    pii: true,
  },
  {
    t: "様　ほか6名\n\n",
  },
  {
    t: "2. 同じブックの「家族連絡先」シート（選択範囲に巻き込まれた）：\n　",
  },
  {
    t: "青木 次郎",
    pii: true,
  },
  {
    t: "（長男）　",
  },
  {
    t: "090-0000-0114",
    pii: true,
  },
  {
    t: "　",
  },
  {
    t: "j.aoki@example.com",
    pii: true,
  },
  {
    t: "\n　",
  },
  {
    t: "石川 真理",
    pii: true,
  },
  {
    t: "（長女）　",
  },
  {
    t: "090-0000-0227",
    pii: true,
  },
  {
    t: "　",
  },
  {
    t: "ishikawa.mari@example.com",
    pii: true,
  },
  {
    t: "\n　",
  },
  {
    t: "上田 節子",
    pii: true,
  },
  {
    t: "（妻）　",
  },
  {
    t: "090-0000-0338",
    pii: true,
  },
  {
    t: "　",
  },
  {
    t: "ueda.setsuko@example.com",
    pii: true,
  },
  {
    t: "\n\n",
  },
  {
    t: "3. 同じブックの「退院支援」シートの住所欄：\n　",
  },
  {
    t: "白砂野市 若葉町3丁目12-4",
    pii: true,
  },
  {
    t: "　",
  },
  {
    t: "白砂野市 緑ヶ丘1-8-207",
    pii: true,
  },
  {
    t: "　",
  },
  {
    t: "白砂野市 浜見東42-1",
    pii: true,
  },
  {
    t: "\n\n",
  },
  {
    t: "以上について、外部への送信は成立していないが、選択範囲に含まれていたため報告する。",
  },
];

/** 匿名化してから渡された依頼への台本応答の前置き（モック S5_AI_REPLY）。 */
export const stage5AiReply = [
  "承知しました。氏名列を除いた一覧に整えました。",
  "患者ID・病棟・発熱確認日・体温の並びで、保健所提出用にそのまま使える形です。",
] as const satisfies Lines;

/** 台本応答の整形済み表の列見出し（モック S5_SCRIPTED_COLS）。表の中身の整形は domain 側。 */
export const stage5ScriptedColumns = [
  "患者ID",
  "病棟",
  "発熱確認日",
  "最高体温",
] as const satisfies readonly string[];

type Stage5FormatRejectReason = "fullwidth" | "date" | "temp";

/** 書式の差し戻しの前置き。事務長の口調で、事実だけを言う。 */
const FORMAT_REJECT_LEAD = "保健所に出す書式になっていません。";

/** 書式の差し戻しの中身（理由ごとに1文）。 */
const FORMAT_REJECT_ITEMS = {
  fullwidth: "全角の数字が残っています。",
  date: "日付の書き方を1種類に揃えてください。",
  temp: "体温の単位の付け方を揃えてください。",
} as const satisfies Readonly<Record<Stage5FormatRejectReason, string>>;

/** 提出の書式が揃っていないときの差し戻し（モック S5_FORMAT_REJECTS）。判定は理由のキーだけを返し、文言はここから引く。 */
export const stage5FormatRejects = {
  fullwidth: `${FORMAT_REJECT_LEAD}${FORMAT_REJECT_ITEMS.fullwidth}`,
  date: `${FORMAT_REJECT_LEAD}${FORMAT_REJECT_ITEMS.date}`,
  temp: `${FORMAT_REJECT_LEAD}${FORMAT_REJECT_ITEMS.temp}`,
} as const satisfies Readonly<Record<Stage5FormatRejectReason, string>>;

/**
 * 提出の差し戻し理由1つ。domain の S5RejectReason と同じ形（content は domain を import しない）。
 * 不足IDは提出本文から取らず、domain が一覧の並び順で返したものだけを受け取る。
 */
export type Stage5RejectReason =
  | { readonly reason: "ids"; readonly missingIds: readonly string[] }
  | { readonly reason: Stage5FormatRejectReason };

/** IDが足りないときの差し戻し（モック checkStage5 の ids の文言）。 */
const missingIdsLine = (missingIds: readonly string[]): string =>
  `あと${String(missingIds.length)}名分足りないようです（不足ID：${missingIds.join("・")}）。`;

/**
 * 書式の差し戻しの段落。理由が1つならモックと同じ1文、2つ以上なら前置きの後に
 * 件数を添えて箇条書きで並べる（#221）。
 */
const formatRejectLines = (reasons: readonly Stage5FormatRejectReason[]): string[] => {
  const [only, ...rest] = reasons;
  if (only === undefined) return [];
  if (rest.length === 0) return [stage5FormatRejects[only]];
  return [
    `${FORMAT_REJECT_LEAD}直すところが${String(reasons.length)}つあります。`,
    ...reasons.map((reason) => `・${FORMAT_REJECT_ITEMS[reason]}`),
  ];
};

/**
 * 提出の差し戻しで見せる行（#221）。domain が返した理由を並び順のまま受け取り、
 * IDの不足を先に、書式の不備を後に置く。理由が1つだけならモックの差し戻し文と同じ。
 */
export const stage5SubmissionRejectLines = (reasons: readonly Stage5RejectReason[]): string[] => {
  const idLines = reasons.flatMap((r) =>
    r.reason === "ids" ? [missingIdsLine(r.missingIds)] : [],
  );
  const formatReasons = reasons.flatMap((r) => (r.reason === "ids" ? [] : [r.reason]));
  return [...idLines, ...formatRejectLines(formatReasons)];
};

/** 課題文（モック renderStage5 の .brief）。 */
export const stage5Brief = "保健所へ提出する発熱患者一覧を整えよ。";

/** 画面の見出しとボタン（モック renderStage5 と s5DeadlineFrame の直書き）。 */
export const stage5Labels = {
  submit: "保健所へ提出",
  /** 提出欄の読み上げ名（モックの textarea には名前が無い。本番で足した）。 */
  listField: "保健所へ提出する一覧",
  /** ミッションバーの期限の前に置く言葉（モック #s5-dl の span）。 */
  deadline: "保健所の提出期限",
  /** 期限を過ぎたら時刻の代わりに出す（モック s5DeadlineFrame）。 */
  deadlineOver: "回答期限超過",
} as const;

/** 提出が通ったとき（モック runStage5Verdict の .done）。 */
export const stage5Cleared = "Stage 5 をクリアしました";

/** 罠の初回の警報（モック #ov-alarm）。責める言葉も安心させる言葉も置かず、事実だけ。 */
export const stage5Alarm = {
  title: "個人情報インシデント発生",
  sub: "送信はブロックされました。",
} as const;

/** 事務長の内線の窓（モック #ov-s5scold・#ov-s5call の見出しと肖像。どちらも同じ）。 */
export const stage5Call = {
  tb: "📞 内線 — 事務長",
  img: "stage1-administrative-director.png",
  role: "事務長",
  org: "病院執行部",
  /** 罠の初回の叱責は窓ではなく全画面で出す（Issue #29）。そのときの 16:9 の一枚絵。督促は窓のまま。 */
  scoldFullscreen: { img: "stage5-administrative-director-scold.webp" },
  close: "了解しました",
} as const;

/** 罠の初回、警報の後の事務長の叱責（モック #ov-s5scold の .say）。行為と重大性だけを指す。 */
export const stage5ScoldLines = [
  "いま、何を送りかけたか、分かっていますか。患者の個人情報ですよ。",
  "保健所に提出するのと、外部のAIに流すのは、まったく別の話です。",
  "……インシデント報告書を書いてもらいます。",
] as const satisfies Lines;

/** 提出期限を過ぎたときの事務長の督促（モック #ov-s5call の .say）。1回きり。 */
export const stage5CallLines = [
  "ああ、ICTさん。保健所への一覧、まだ提出できていませんよね？",
  "向こうの窓口から、うちに直接催促の電話が来ています。",
  "急かして悪いけど、今日中という話なので、なるべく早く出してもらえますか。",
] as const satisfies Lines;

/** 罰ゲーム（報告書の黒塗り）の窓（モック startS5Penalty・submitReport）。 */
export const stage5Penalty = {
  heading: "罰ゲーム：報告書の作成",
  note: "個人情報にあたる箇所を黒く塗り、提出してください。",
  submit: "報告書を提出",
  /** 「送信しました」を見せてから窓を閉じるまで（モック later(finishS5Penalty, 1200)）。 */
  sentMs: 1_200,
} as const;

/** 報告書の判定の文（モック submitReport）。塗り残しと塗りすぎは両方並ぶことがある。 */
export const stage5ReportVerdicts = {
  missing: "個人情報が残っています。",
  over: "不必要な部分まで黒く塗られています。",
  sent: "報告書を医療安全管理室へ送信しました。",
} as const;

/**
 * 提出・報告書がサーバへ届かなかったとき。モックはサーバへ送らないので対応する文言が無い
 * （本番で足した文言。Stage 4 と同じ言い方にそろえる）。
 */
export const stage5SendFailed = stage4SendFailed;
