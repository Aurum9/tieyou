CREATE TABLE deck_shares (
  account_id TEXT NOT NULL REFERENCES standalone_auth_accounts(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, deck_id)
);
