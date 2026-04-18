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
