CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL DEFAULT '',
  team_code TEXT NOT NULL,
  kind TEXT NOT NULL,
  view TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  command_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  client_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_team ON activity_events(team_code, id);
CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity_events(kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_command ON activity_events(event_id, team_code, command_id, kind) WHERE command_id <> '';
