/**
 * `.sql`ファイルの中身（wranglerの既定の取り込み規則でText moduleになる）。
 * デブリーフィングの集計SQL（aggregation/*.sql）を正本のままバンドルするために使う。
 */
declare module "*.sql" {
  const sql: string;
  export default sql;
}
