/**
 * 監査賞の同着処理。本番Worker（debrief.ts）と手元の予備の番付サーバ
 * （scripts/ranking-board/server.mjs）が同じものを読む。予備は素のNodeが型を取り除いて
 * このファイルを直接importするので、ほかのファイルをimportせず、消すだけで済む型注釈
 * （erasable syntax）だけで書く（Issue #343）。
 */

/** 集計SQLの時刻 "YYYY-MM-DD HH:MM:SS.SSS"（UTC）をepoch msへ。 */
const utcMs = (text: string): number => Date.parse(`${text.replace(" ", "T")}Z`);

/**
 * 監査賞の受賞チーム。SQLは所要の短い順なので、先頭と所要（ミリ秒）が同じチームを
 * すべて返す（同着）。s3_minは表示用に丸めてあるので同着の判定には使わない。
 */
export const auditWinners = <T extends { s3_start: string; s3_clear: string }>(
  rows: readonly T[],
): T[] => {
  const duration = (row: T): number => utcMs(row.s3_clear) - utcMs(row.s3_start);
  const [best] = rows;
  if (best === undefined) return [];
  return rows.filter((row) => duration(row) === duration(best));
};
