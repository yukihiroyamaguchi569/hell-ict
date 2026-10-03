/** Viteの`?raw`で読み込んだSQLファイルの中身（集計SQLのテストが使う）。 */
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
