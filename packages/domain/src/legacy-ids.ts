import { CHECKPOINT_IDS_VERSION } from "./schemas/checkpoint.js";

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
 *
 * 体系が確定している場合（版マーカーの有無で判別できるチェックポイント）は、
 * この関数ではなくnormalizeLegacyCheckpointBodyが対応表どおりにずらす。
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
 * 新体系のbodyかどうか。判別は版マーカー（idsVersion）が主で、キーの形は補助。
 *
 * 補助を残すのは、マーカーを入れるより前に新名で保存されたbodyがありうるため
 * ——罠フラグが新名だけを持っていれば、それは振り直し後に書かれたものである。
 * 旧bodyは`trap.s4Used`を持つので、この条件には掛からない。
 */
const isCurrentIdsBody = (body: Record<string, unknown>): boolean => {
  if (body.idsVersion === CHECKPOINT_IDS_VERSION) return true;
  const trap = body.trap;
  return isRecord(trap) && "s5Used" in trap && !("s4Used" in trap);
};

/** 版マーカーを立てる。すでに立っていれば同じオブジェクトを返す（再適用で変化しない）。 */
const withIdsVersion = (body: Record<string, unknown>): Record<string, unknown> =>
  body.idsVersion === CHECKPOINT_IDS_VERSION
    ? body
    : { ...body, idsVersion: CHECKPOINT_IDS_VERSION };

/**
 * 旧名で保存されたチェックポイントのbodyを新名へ読み替える。
 *
 * 版マーカーが無ければ旧体系と決める。マーカーはこちらが書くものなので、書き忘れは
 * 「旧体系として読む」側へ倒れる——キーの有無だけで当てにいくと、旧bodyが罠フラグを
 * 欠いていた場合や将来trapの形が変わった場合に判別が黙って外れ、画面idが旧名のまま
 * strictなschemaへ渡って、そのチームが復帰できなくなる。
 *
 * 検証はしない。呼び出し側が従来どおりschemaへ通す——ここで直せない壊れた値は、
 * 読み替えても壊れたままであるべきで、この関数が握り潰す筋合いは無い。
 */
export const normalizeLegacyCheckpointBody = (body: unknown): unknown => {
  if (!isRecord(body)) return body;
  if (isCurrentIdsBody(body)) return withIdsVersion(body);
  const view = typeof body.view === "string" ? LEGACY_VIEW_SHIFT[body.view] : undefined;
  return withIdsVersion({
    ...body,
    ...(view === undefined ? {} : { view }),
    ...(isRecord(body.trap) ? { trap: renameKey(body.trap, "s4Used", "s5Used") } : {}),
    ...(isRecord(body.data)
      ? { data: LEGACY_DATA_KEYS.reduce((acc, [from, to]) => renameKey(acc, from, to), body.data) }
      : {}),
  });
};

/** `body`を1つ持つ包み（保存済みsnapshot、保存コマンド）の中身を読み替える。 */
const withNormalizedBody = (envelope: unknown): unknown =>
  isRecord(envelope)
    ? { ...envelope, body: normalizeLegacyCheckpointBody(envelope.body) }
    : envelope;

/**
 * チェックポイントのsnapshot全体（`{ teamCode, revision, savedAt, body }`）を読み替える。
 * Durable Objectが保存済みJSONをparseする直前に通す入口。
 */
export const normalizeLegacyCheckpointSnapshot = withNormalizedBody;

/**
 * 保存コマンド（`{ type, commandId, expectedRevision, generation, body, flush }`）を読み替える。
 * デプロイ後も開いたままの旧タブが旧形式のbodyを送ってくる——strictなschemaへそのまま
 * 渡すと400になり、旧UIは保存の失敗を通知しないまま進むので、リロードでデプロイ前まで
 * 巻き戻る。schemaの手前で新体系へ直し、保存されるのは版マーカー付きの新体系だけにする。
 */
export const normalizeLegacyCheckpointCommand = withNormalizedBody;

/**
 * `view`を1つ持つオブジェクト（進捗イベント、活動ログ）の画面idを読み替える。
 * 旧タブから届く`s35`を落とさないための入口で、判別できない`s4`・`s5`は素通りさせる
 * （normalizeLegacyViewIdと同じ理屈）。
 */
export const normalizeLegacyViewField = (input: unknown): unknown =>
  isRecord(input) && typeof input.view === "string"
    ? { ...input, view: normalizeLegacyViewId(input.view) }
    : input;
