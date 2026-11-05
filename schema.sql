-- Fleet Mitra database schema (SQLite dialect of the report's ER diagram, Fig 3.2).
-- The demo runs this exact file inside the browser with sql.js on first load.
-- Foreign keys are switched on separately with PRAGMA foreign_keys = ON.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id                    INTEGER PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id),
  title                 TEXT    NOT NULL,
  description           TEXT    NOT NULL,
  type                  TEXT    NOT NULL CHECK (type IN ('lost', 'found')),
  category              TEXT    NOT NULL,
  location              TEXT    NOT NULL,
  event_date            TEXT    NOT NULL,           -- YYYY-MM-DD
  status                TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'returned', 'hidden')),
  previous_status       TEXT    NULL,               -- kept while an admin hides the item
  image                 TEXT    NULL,               -- random stored upload name
  verification_question TEXT    NOT NULL,
  verification_hash     TEXT    NOT NULL,           -- PBKDF2 hash of the normalised answer
  is_demo               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_filter ON items (status, type, category);

CREATE TABLE IF NOT EXISTS claims (
  id              INTEGER PRIMARY KEY,
  item_id         INTEGER NOT NULL REFERENCES items(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  message         TEXT    NOT NULL,
  answer_verified INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'closed')),
  created_at      TEXT    NOT NULL,
  UNIQUE (item_id, user_id)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket   TEXT    PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL                         -- Unix time in seconds
);
