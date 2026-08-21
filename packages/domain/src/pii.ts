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
 * 生年月日・電話番号は固有情報の書式一致ではなく汎用パターンで拾う——
 * 参加者が値を手で書き写した場合も検知するため（docs/ui/mock/index.html §S4_PII）。
 *
 * 院内ID単独（例: 患者ID「005」）は検知対象に含めない（2026-08-22 ユーザー決定）。
 * Stage 2のラインリストは匿名化教材であり、患者IDだけを含む——氏名列を持たない
 * （006・008を含む素の数字がそのまま貼られるため）。IDのみに反応すると、匿名化済み
 * データを貼っただけでゲートが誤射する。氏名・生年月日・電話番号など直接識別子は
 * 引き続き検知するため、Stage 4カルテ（stage4_chart.md）の実際のPII漏洩は従来どおり
 * 検知される——Stage 4のカルテ抜粋はIDだけでなく氏名・生年月日を同じ文中に含む。
 *
 * 電話番号の区切り文字は`[-\s]`ではなく、半角ハイフン・半角スペース・全角スペース（U+3000）
 * だけを許容する形にする。`\s`は改行にも一致するため、改行区切りの数値列（例: Stage 4正解
 * 経路でAIに渡す発熱患者ID一覧「005\n006\n008…」）が電話番号として誤検知されていた
 * （2026-08-22 モック側S4_PII検証で発見）。
 */
export const piiPatterns = [
  { label: "患者氏名", re: namesToPattern(feverLinelistPatientNames) },
  { label: "生年月日", re: /\d{4}年\d{1,2}月\d{1,2}日/ },
  { label: "電話番号", re: /0\d{1,4}[- \u3000]?\d{2,4}[- \u3000]?\d{3,4}/ },
  { label: "ご家族の氏名", re: nameToPattern(stage4Patient.familyName) },
] as const satisfies readonly PiiPattern[];

export type PiiLabel = (typeof piiPatterns)[number]["label"];

/** テキストがStage 4の個人情報を含むか検査し、最初に一致したラベルを返す。 */
export const detectPii = (text: string): PiiLabel | null =>
  piiPatterns.find((pattern) => pattern.re.test(text))?.label ?? null;
