CREATE TABLE IF NOT EXISTS progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_code TEXT NOT NULL,
  team_name TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL,
  view TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  client_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_progress_team ON progress_events(team_code, id);
