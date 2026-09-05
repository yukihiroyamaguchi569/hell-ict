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

/**
 * 列追加の移行が必要とするのは`exec`だけ。テストからFakeを渡せるよう最小限へ絞る
 * （`SqlStorage`のexecはgenericで、Fakeが返す値を作れない）。
 */
export type AddColumnRunner = { readonly exec: (query: string) => unknown };

/**
 * `ALTER TABLE ... ADD COLUMN`を順に当て、「列が既にある」失敗だけを握って次へ進む。
 * それ以外の失敗はその場で投げ、残りの文を実行しない。
 *
 * 対象テーブルの`CREATE TABLE`をすべて流し終えてから呼ぶこと。まだ無いテーブルへ当てると
 * `no such table`で失敗し、握らないここでは初期化そのものが落ちる。
 */
export const applyAddColumns = (sql: AddColumnRunner, statements: readonly string[]): void => {
  for (const statement of statements) {
    try {
      sql.exec(statement);
    } catch (caught) {
      if (!isDuplicateColumn(caught)) throw caught;
    }
  }
};
