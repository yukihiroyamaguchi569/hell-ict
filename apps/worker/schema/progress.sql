CREATE TABLE IF NOT EXISTS progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_code TEXT NOT NULL,
  team_name TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL,
  view TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  -- リセット世代。ゲームマスターのリセットのたびに進み、集計は「そのチームの
  -- reset行の最大世代以上」の行だけを数える（src/progress.tsのteamsSql）。
  generation INTEGER NOT NULL DEFAULT 0,
  client_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_progress_team ON progress_events(team_code, id);
-- リセット世代の集計（src/progress.tsのRESET_GENERATION_CTE）専用の部分インデックス。
-- reset行は全体のごく一部なので、これが無いとサマリーの2本が毎回テーブル全体を
-- 1回ずつ余計に走査する。
CREATE INDEX IF NOT EXISTS idx_progress_reset ON progress_events(team_code, generation) WHERE kind = 'reset';
-- 一度きりの移行の完了印。名前だけを持つ。
CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
