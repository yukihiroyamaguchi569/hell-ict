/**
 * Stage 4 教材（docs/materials/stage4_chart.md）に載る固有情報。
 * 送信前ゲートの検知パターンはここから組み立てる——検知パターンと教材が
 * 別々の場所にあり片方だけ直して静かに壊れる事態（Stage 3が踏んだ負債）を避けるため。
 * 教材との一致は test/materials/materials.test.ts で固定する。
 */
export const stage4Patient = {
  name: "渡辺 三郎",
  id: "005",
  dob: "1952年3月14日",
  phone: "090-1234-5678",
  familyName: "渡辺 健一",
} as const;

type PiiPattern = { readonly label: string; readonly re: RegExp };

/**
 * 姓と名の間の半角スペース1つを`\s*`（0個以上の空白類）へ置き換え、表記ゆれを
 * 吸収する正規表現へ組み立てる。JSの`\s`は全角スペース（U+3000）も含むため、
 * 全角スペース区切り・スペースなし・複数スペースのいずれの表記も一致する。
 */
const nameToPattern = (fullName: string): RegExp => new RegExp(fullName.replace(" ", "\\s*"));

/** 複数の氏名を`nameToPattern`と同じ表記ゆれ吸収規則で1つの選言（`|`）正規表現へ組み立てる。 */
const namesToPattern = (fullNames: readonly string[]): RegExp =>
  new RegExp(fullNames.map((fullName) => fullName.replace(" ", "\\s*")).join("|"));

/**
 * Stage 4再設計（保健所への発熱患者一覧提出・個人名入りExcel丸貼りが罠）の
 * 教育用ダミー患者14名。教育用ダミー患者の氏名を列挙で検知する——汎用の日本人名
 * ヒューリスティックにはしない（誤検知でゲームが壊れる方が害が大きい）。
 * 名簿の正典は docs/materials/stage4_fever_linelist.tsv（2026-08-22 Stage 4再設計）。
 * 名簿を変えたらここも変える。
 */
const feverLinelistPatientNames = [
  stage4Patient.name,
  "田島 早苗",
  "大久保 誠",
  "三好 千鶴",
  "井原 隆之",
  "柴崎 恵美",
  "若林 順平",
  "真田 郁子",
  "小野田 保",
  "桑原 里美",
  "志村 幸雄",
  "浅井 弥生",
  "堀口 巧",
  "長峰 静香",
] as const;

/**
 * 教材の生年月日（`stage4Patient.dob`）を、表記ゆれを吸収した正規表現へ組み立てる。
 * 「YYYY年M月D日」に加え、記号区切り（1952/3/14・1952-03-14・1952.3.14）と
 * 月日のゼロ詰め（3ではなく03）を許容する。前後を数字境界で挟み、長い数値列の
 * 途中から切り出して一致することを防ぐ。
 *
 * 汎用の日付パターン（`\d{4}年\d{1,2}月\d{1,2}日`）は使わない——研修当日の日付を
 * 書いただけの依頼（例:「2026年8月22日の研修内容をまとめて」）でゲートが誤射する
 * （2026-08-22 実測）。教材に載る生年月日は005の1件だけなので、検知対象を教材から
 * 組み立てれば、このファイル冒頭の「検知パターンと教材を単一情報源にする」方針とも
 * 揃う。名簿（stage4_fever_linelist.tsv）は生年月日列を持たない。教材へ生年月日を
 * 増やしたらここも増やす。
 */
const dobToPattern = (dob: string): RegExp => {
  const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(dob);
  const year = parts?.[1];
  const month = parts?.[2];
  const day = parts?.[3];
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`生年月日「${dob}」が想定の書式（YYYY年M月D日）ではありません。`);
  }
  const optionalZero = (value: string): string => (value.length === 1 ? `0?${value}` : value);
  const m = optionalZero(month);
  const d = optionalZero(day);
  return new RegExp(`(?<!\\d)${year}(?:年${m}月${d}日|[-/.]${m}[-/.]${d}(?!\\d))`);
};

/**
 * 電話番号は固有情報の書式一致ではなく汎用パターンで拾う——
 * 参加者が値を手で書き写した場合も検知するため（docs/ui/mock/index.html §S4_PII）。
 *
 * 院内ID単独（例: 患者ID「005」）は検知対象に含めない（2026-08-22 ユーザー決定）。
 * Stage 2のラインリストは匿名化教材であり、患者IDだけを含む——氏名列を持たない
 * （006・008を含む素の数字がそのまま貼られるため）。IDのみに反応すると、匿名化済み
 * データを貼っただけでゲートが誤射する。氏名・生年月日・電話番号など直接識別子は
 * 引き続き検知するため、Stage 4カルテ（stage4_chart.md）の実際のPII漏洩は従来どおり
 * 検知される——Stage 4のカルテ抜粋はIDだけでなく氏名・生年月日を同じ文中に含む。
 *
 * 電話番号パターンには3つの制約を課す。いずれもStage 4の正解経路——氏名列を落とした
 * ID列をAIへ渡す——が電話番号として誤検知され、罰が誤爆した実測に基づく。
 *
 * 1. 区切り文字は`[-\s]`ではなく、半角ハイフン・半角スペース・全角スペース（U+3000）
 *    だけを許容する。`\s`は改行にも一致するため、改行区切りのID一覧
 *    （「005\n006\n008…」）が電話番号として誤検知されていた
 *    （2026-08-22 モック側S4_PII検証で発見）。
 * 2. 前後を数字境界（`(?<!\d)`・`(?!\d)`）で挟み、長い数値列の途中から切り出さない。
 * 3. 末尾の加入者番号を4桁固定にする。携帯（090-1234-5678）も固定電話
 *    （市外局番1〜4桁＋市内局番＋4桁）も末尾は4桁で、合計10〜11桁になる。旧パターンの
 *    末尾`\d{3,4}`は3桁を許したため、スペース区切りのID列「005 006 008」（合計9桁）に
 *    一致していた（2026-08-22 実測）。
 */
export const piiPatterns = [
  { label: "患者氏名", re: namesToPattern(feverLinelistPatientNames) },
  { label: "生年月日", re: dobToPattern(stage4Patient.dob) },
  { label: "電話番号", re: /(?<!\d)0\d{1,3}[- \u3000]?\d{2,4}[- \u3000]?\d{4}(?!\d)/ },
  { label: "ご家族の氏名", re: nameToPattern(stage4Patient.familyName) },
] as const satisfies readonly PiiPattern[];

export type PiiLabel = (typeof piiPatterns)[number]["label"];

/** テキストがStage 4の個人情報を含むか検査し、最初に一致したラベルを返す。 */
export const detectPii = (text: string): PiiLabel | null =>
  piiPatterns.find((pattern) => pattern.re.test(text))?.label ?? null;

/**
 * JSON値の全体を1本の文字列として検査する。値が1つのフィールドに収まっている
 * ケースはこれで拾える。JSONへ落とせない値（循環参照など）は諦めて、下の再帰走査
 * だけに委ねる——ここで例外を投げると、検査そのものが呼び出し側を壊してしまう。
 */
const stringifiedHasPii = (value: unknown): boolean => {
  try {
    // JSON.stringifyは型定義上stringを返すが、undefinedや関数に対しては実際には
    // undefinedを返す。その場合は全体走査を諦め、walkHasPiiだけに委ねる。
    const json: unknown = JSON.stringify(value);
    return typeof json === "string" && detectPii(json) !== null;
  } catch {
    return false;
  }
};

/** 各string値と各キーを個別に検査する。 */
const walkHasPii = (value: unknown): boolean => {
  if (typeof value === "string") return detectPii(value) !== null;
  if (Array.isArray(value)) return value.some(walkHasPii);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, child]) => detectPii(key) !== null || walkHasPii(child),
    );
  }
  return false;
};

/**
 * JSON値にPIIが混ざっているかを再帰的に調べる。
 *
 * 全体走査と個別走査を両側から掛ける。JSON全体を1回見るだけでは足りない——値が
 * 別々のフィールドへ分かれていると、JSON上ではキー名や区切り記号を挟んで分断され、
 * パターンに一致しなくなる。逆に個別の値だけを見るのも足りない——JSON.stringifyが
 * 繋げた並びで初めて一致する形を取りこぼす。
 *
 * オブジェクトのキーも検査する。キーを自由文字列にできる入力（チェックポイントの
 * data）では、値ではなくキー側へPIIを置く経路が残るため。
 *
 * 深さの保証は呼び出し側の責務とする（チェックポイントはschemaの
 * CHECKPOINT_DATA_MAX_DEPTH、活動ログのmetaは平坦なrecord）。ここではJSON.parse
 * 由来の、循環参照を持たない値を前提に素直に辿る。
 *
 * ただし検出器の語彙を跨ぐ分割（姓と名を別フィールドへ置くなど）は原理的に拾えない。
 * これはdetectPiiの限界であり、ここで塞げるものではない。
 */
export const containsPii = (value: unknown): boolean =>
  stringifiedHasPii(value) || walkHasPii(value);

/** 伏せ字。元の桁数から値を推測させないよう、一致した長さに合わせず固定にする。 */
export const PII_REDACTION = "■■■";

/**
 * 既知のPIIパターンをすべて伏せ字へ置き換える。detectPiiは「最初に一致したラベル」
 * しか返さず位置も教えないので、置換のためにパターンを全件・全出現へ当て直す。
 *
 * AI応答に対しては保存拒否ではなく伏せ字を選ぶ。拒否にするとクライアントが再送し、
 * OpenAIは同じ本文に同じような応答を返しやすいので、課金と待ち時間が増えるだけで
 * 前へ進まない。伏せ字なら会話の文脈は残り、PIIだけがDOから消える。
 */
export const redactPii = (text: string): string =>
  piiPatterns.reduce(
    (redacted, pattern) =>
      redacted.replace(
        new RegExp(pattern.re.source, `${pattern.re.flags.replace("g", "")}g`),
        PII_REDACTION,
      ),
    text,
  );
