CREATE TABLE IF NOT EXISTS scoreboard_games (
  account_id TEXT NOT NULL REFERENCES standalone_auth_accounts(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(account_id, game_id)
);
CREATE INDEX IF NOT EXISTS scoreboard_games_timeline ON scoreboard_games(account_id, started_at DESC, game_id DESC);
