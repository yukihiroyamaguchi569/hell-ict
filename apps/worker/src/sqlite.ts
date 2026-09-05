/**
 * SQLite（D1とDurable Objectのストレージ）が返す失敗の見分け方。移行のcatchを
 * 「握ってよい失敗」だけに絞るために使う。
 */

/**
 * `ALTER TABLE ... ADD COLUMN`が「列が既にある」で失敗したときだけ真を返す。
 * SQLiteはこの場合だけ`duplicate column name: <列名>`を返す。
 *
 * `ADD COLUMN`に`IF NOT EXISTS`は無いので、既にテーブルを持つ環境では2度目以降
 * 必ず失敗する。その1種類だけを握るのが目的であって、すべての例外を握ってはいけない
 * ——テーブルが無い、ストレージが落ちている、といった本物の失敗まで「移行済み」として
 * 通すと、列の無いまま初期化が成功扱いで固定され、以後の書き込みが延々失敗し続ける。
 */
export const isDuplicateColumn = (caught: unknown): boolean =>
  caught instanceof Error && caught.message.includes("duplicate column name");
