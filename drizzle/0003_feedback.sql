CREATE TABLE IF NOT EXISTS feedback_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id TEXT NOT NULL REFERENCES standalone_auth_accounts(id),
  body TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(author_id, request_id)
);
CREATE INDEX IF NOT EXISTS feedback_posts_newest ON feedback_posts(id DESC);
CREATE INDEX IF NOT EXISTS feedback_posts_author ON feedback_posts(author_id, created_at);
CREATE TABLE IF NOT EXISTS feedback_images (
  id TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES feedback_posts(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_images_post ON feedback_images(post_id, position);
CREATE TABLE IF NOT EXISTS feedback_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES feedback_posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES standalone_auth_accounts(id),
  body TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(author_id, request_id)
);
CREATE INDEX IF NOT EXISTS feedback_replies_post ON feedback_replies(post_id, id);
CREATE INDEX IF NOT EXISTS feedback_replies_author ON feedback_replies(author_id, created_at);
