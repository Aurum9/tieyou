CREATE TABLE tag_settings_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  mutation TEXT NOT NULL DEFAULT ''
);
INSERT INTO tag_settings_state(id, revision, mutation) VALUES(1, 0, '');
CREATE TABLE tag_label_overrides (
  slug TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  visible INTEGER NOT NULL CHECK (visible IN (0, 1))
);
