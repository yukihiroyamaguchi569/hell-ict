import { GAME_TABLES_DDL } from "./game-store.js";
import { applyAddColumns } from "./sqlite.js";

/**
 * ゲームマスターのリセットで空にするテーブル。DDLで作っているもののうち`migrations`以外
 * すべてを列挙する。テーブルを足したらここへも足す——消し忘れると、リセットしたつもりの
 * チームに古い状態が残る。
 *
 * `migrations`だけ残すのは、完了印が指す移行が「台帳に残った平文PIIを潰す」ものであり、
 * 行ごと消した後にもう一度走らせる意味が無いためである。
 */
export const RESET_TABLES = [
  "team_state",
  "processed_commands",
  "chat_state",
  "processed_thread_commands",
  "processed_message_commands",
  "pending_message_commands",
  "checkpoint_state",
  "processed_checkpoint_commands",
  "rate_limit",
  "game_state",
  "processed_game_commands",
  "game_standing_outbox",
  "game_progress_outbox",
  "game_activity_outbox",
] as const;

/** RESET_TABLESに入れないテーブル。理由はそれぞれの定義の注記にある。 */
export const RESET_KEPT_TABLES = ["reset_generation", "migrations"] as const;

/**
 * 既にテーブルを持つDOには`CREATE TABLE IF NOT EXISTS`が効かないので、列は後から足す。
 * `ADD COLUMN`に`IF NOT EXISTS`は無く、2度目以降は必ず「列が既にある」で失敗するので、
 * その1種類だけを握る（applyAddColumns）。ほかの失敗まで握ると、列の無いまま
 * コンストラクタが通り、以後の読み書きが欠けた列を相手に延々失敗し続ける。
 *
 * 既存行のprompt_profileはNULLになり、照合をスキップする（team-room.tsのmismatchesPending）。
 *
 * テストが各文を直接当てて「移行後は全列が揃っている」ことを確かめるので公開する。
 */
export const TEAM_ROOM_ADD_COLUMNS = [
  "ALTER TABLE pending_message_commands ADD COLUMN prompt_profile TEXT",
  "ALTER TABLE pending_message_commands ADD COLUMN fingerprint TEXT",
  "ALTER TABLE processed_message_commands ADD COLUMN fingerprint TEXT",
  "ALTER TABLE pending_message_commands ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE processed_thread_commands ADD COLUMN fingerprint TEXT",
  "ALTER TABLE processed_checkpoint_commands ADD COLUMN fingerprint TEXT",
] as const;

/**
 * Creates the TeamRoom tables in order: CREATE, then ADD COLUMN, then the game tables.
 * Synchronous on purpose; the Durable Object constructor runs it.
 */
export const ensureTeamRoomTables = (sql: SqlStorage): void => {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS team_state (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS processed_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS chat_state (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS processed_thread_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL, fingerprint TEXT)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS processed_message_commands (command_id TEXT PRIMARY KEY, result TEXT NOT NULL, fingerprint TEXT)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pending_message_commands (command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at TEXT NOT NULL, claimed_at TEXT, prompt_profile TEXT, fingerprint TEXT, claim_generation INTEGER NOT NULL DEFAULT 0)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS checkpoint_state (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS processed_checkpoint_commands (command_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, fingerprint TEXT)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS rate_limit (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL)",
  );
  // リセット世代。RESET_TABLESに含めない——リセットのたびに消してしまうと、
  // 「何回リセットしたか」が失われて古い端末を見分けられなくなる。
  sql.exec(
    "CREATE TABLE IF NOT EXISTS reset_generation (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)",
  );
  sql.exec("INSERT OR IGNORE INTO reset_generation (id, value) VALUES (1, 0)");
  sql.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)");
  // 列の追加はCREATE群をすべて流し終えてから当てる。対象テーブルより先に当てると、
  // 新しいDOでは`no such table`で失敗する（握らないので初期化ごと落ちる）。
  applyAddColumns(sql, TEAM_ROOM_ADD_COLUMNS);
  for (const statement of GAME_TABLES_DDL) sql.exec(statement);
};
