PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  handler         TEXT NOT NULL,
  chat_id         INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT NOT NULL,
  source_kind     TEXT,
  tone            TEXT,
  shape           TEXT,
  length          TEXT,
  output_path     TEXT,
  subprocess_pid  INTEGER,
  tts_chars       INTEGER,
  tts_usd         REAL,
  stop_reason     TEXT,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS pending_length_choices (
  job_id          TEXT PRIMARY KEY,
  chat_id         INTEGER NOT NULL,
  keyboard_msg_id INTEGER NOT NULL,
  source_tmpfile  TEXT NOT NULL,
  tone_prefix     TEXT,
  shape_prefix    TEXT,
  expires_at      INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS rate_limits_hourly (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  handler         TEXT NOT NULL,
  timestamp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rl_hourly_user_ts ON rate_limits_hourly(user_id, timestamp);

CREATE TABLE IF NOT EXISTS rate_limits_daily_spend (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  timestamp       INTEGER NOT NULL,
  tts_usd         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rl_daily_user_ts ON rate_limits_daily_spend(user_id, timestamp);
