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

/**
 * 生年月日・電話番号は固有情報の書式一致ではなく汎用パターンで拾う——
 * 参加者が値を手で書き写した場合も検知するため（docs/ui/mock/index.html §S4_PII）。
 */
export const piiPatterns = [
  { label: "患者氏名", re: nameToPattern(stage4Patient.name) },
  { label: "患者ID", re: /(?<!\d)005(?!\d)/ },
  { label: "生年月日", re: /\d{4}年\d{1,2}月\d{1,2}日/ },
  { label: "電話番号", re: /0\d{1,4}[-\s]?\d{2,4}[-\s]?\d{3,4}/ },
  { label: "ご家族の氏名", re: nameToPattern(stage4Patient.familyName) },
] as const satisfies readonly PiiPattern[];

export type PiiLabel = (typeof piiPatterns)[number]["label"];

/** テキストがStage 4の個人情報を含むか検査し、最初に一致したラベルを返す。 */
export const detectPii = (text: string): PiiLabel | null =>
  piiPatterns.find((pattern) => pattern.re.test(text))?.label ?? null;
