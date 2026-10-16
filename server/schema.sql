-- WebDrop server database (Cloudflare D1 / SQLite). Safe to run more than once.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,             -- Google account id ("sub")
  email TEXT,
  name TEXT,
  picture TEXT,
  username TEXT UNIQUE COLLATE NOCASE,
  show_name INTEGER NOT NULL DEFAULT 1,  -- Workshop: show username, or "Anonymous #anon_no"
  anon_no INTEGER,
  qb INTEGER NOT NULL DEFAULT 3,   -- Quick Build tokens
  pic INTEGER NOT NULL DEFAULT 3,  -- Custom Picture tokens
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS licences (
  key TEXT PRIMARY KEY,            -- WD-XXXX-XXXX-XXXX
  user_id TEXT,
  plan TEXT NOT NULL,              -- week | month | year | life
  exp INTEGER,                     -- ms timestamp, NULL = lifetime
  promo TEXT,
  lily INTEGER NOT NULL DEFAULT 0,
  money INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,  -- cents charged
  payment TEXT,                    -- Stripe PaymentIntent id
  created INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS licences_user ON licences(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS licences_payment ON licences(payment);

CREATE TABLE IF NOT EXISTS promo_uses (
  code TEXT PRIMARY KEY,
  uses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  code TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT,
  pkg TEXT,
  status TEXT NOT NULL,            -- queued | building | ready | failed | error
  msg TEXT,
  ultra INTEGER NOT NULL DEFAULT 0,
  used_pic INTEGER NOT NULL DEFAULT 0,
  charged INTEGER NOT NULL DEFAULT 0,
  apk_url TEXT,
  run_url TEXT,
  created INTEGER NOT NULL,
  inputs TEXT,                     -- waiting for the queue job (JSON)
  dispatched INTEGER NOT NULL DEFAULT 1,
  dispatched_at INTEGER
);
CREATE INDEX IF NOT EXISTS builds_user ON builds(user_id);

CREATE TABLE IF NOT EXISTS workshop (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT,
  apk_url TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS workshop_created ON workshop(created);

CREATE TABLE IF NOT EXISTS workshop_reports (
  item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
