/**
 * 2026-09-06、画面の内部名を表示番号へ揃えた（Issue #118）。表示番号は2026-08-22に
 * 振り直してあり、内部名だけが旧番号のまま残っていた：
 *
 *   旧 s35（新情報の解釈） → 新 s4
 *   旧 s4 （報告）         → 新 s5
 *   旧 s5 （掲示）         → 新 s6
 *
 * 振り直しより前に保存された値がサーバに残っているので、読むときだけここで新名へ
 * 読み替える。書くのは新名だけで、D1に積んだ過去の活動ログは書き換えない
 * （分析時の対応表は docs/testplay/ログ分析手順.md）。
 */

/** 旧番号→新番号。旧番号だと確定している値にだけ当てる。 */
const LEGACY_VIEW_SHIFT: Readonly<Record<string, string>> = {
  s35: "s4",
  s4: "s5",
  s5: "s6",
};

/**
 * 新旧どちらの体系で書かれたか分からない画面idを、安全な範囲だけ読み替える。
 *
 * `s35`は新体系に存在しないので、見つかれば必ず旧番号——ここだけは確実に直せる。
 * `s4`・`s5`は新旧どちらの体系にもあり、値だけでは判別できないので素通りさせる。
 * 判別できないまま一律にずらすと、振り直し後に書かれた値まで1つ後ろへ動いてしまい、
 * 直せる古い行より壊す新しい行のほうが多くなる。
 */
export const normalizeLegacyViewId = (view: string): string => (view === "s35" ? "s4" : view);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `from`があれば`to`へ移した新しいオブジェクトを返す。無ければそのまま返す。 */
const renameKey = (
  source: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> => {
  if (!(from in source)) return source;
  const { [from]: moved, ...rest } = source;
  return { ...rest, [to]: moved };
};

/** dataの中でステージ番号を名前に持つキー。中身は不透明なまま、キーだけを付け替える。 */
const LEGACY_DATA_KEYS: readonly (readonly [string, string])[] = [
  ["s4Penalty", "s5Penalty"],
  ["s35Summary", "s4Summary"],
];

/**
 * 旧名で保存されたチェックポイントのbodyを新名へ読み替える。
 *
 * 世代の判別は罠フラグのキーで行う——旧bodyは`trap.s4Used`、新bodyは`trap.s5Used`を
 * 持つので、値ではなくキーの形で「振り直しより前に書かれた」ことが確定する。確定した
 * ときだけ、画面idも旧→新の対応表どおりにずらす（このbodyに限っては`s4`・`s5`の
 * 曖昧さが無い）。新しいbodyは触らずそのまま返す。
 *
 * 検証はしない。呼び出し側が従来どおりschemaへ通す——ここで直せない壊れた値は、
 * 読み替えても壊れたままであるべきで、この関数が握り潰す筋合いは無い。
 */
export const normalizeLegacyCheckpointBody = (body: unknown): unknown => {
  if (!isRecord(body)) return body;
  const trap = body.trap;
  if (!isRecord(trap) || !("s4Used" in trap)) return body;
  const view = typeof body.view === "string" ? LEGACY_VIEW_SHIFT[body.view] : undefined;
  const data = isRecord(body.data)
    ? LEGACY_DATA_KEYS.reduce((acc, [from, to]) => renameKey(acc, from, to), body.data)
    : body.data;
  return {
    ...body,
    ...(view === undefined ? {} : { view }),
    trap: renameKey(trap, "s4Used", "s5Used"),
    data,
  };
};

/**
 * チェックポイントのsnapshot全体（`{ teamCode, revision, savedAt, body }`）を読み替える。
 * Durable Objectが保存済みJSONをparseする直前に通す入口。
 */
export const normalizeLegacyCheckpointSnapshot = (snapshot: unknown): unknown => {
  if (!isRecord(snapshot)) return snapshot;
  return { ...snapshot, body: normalizeLegacyCheckpointBody(snapshot.body) };
};
