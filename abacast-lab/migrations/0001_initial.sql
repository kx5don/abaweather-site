CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
  schedule_bucket TEXT UNIQUE,
  location_name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  time_zone TEXT NOT NULL,
  forecast_office TEXT,
  station_id TEXT,
  station_name TEXT,
  weather_json TEXT NOT NULL,
  afd_json TEXT,
  system_prompt TEXT NOT NULL,
  input_text TEXT NOT NULL,
  openai_json TEXT NOT NULL,
  anthropic_json TEXT NOT NULL,
  gemini_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS experiments_created_at_idx
  ON experiments(created_at_epoch DESC);

CREATE TABLE IF NOT EXISTS generation_locks (
  lock_key TEXT PRIMARY KEY,
  acquired_at_epoch INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_rate_limits (
  rate_key TEXT PRIMARY KEY,
  last_run_epoch INTEGER NOT NULL
);
