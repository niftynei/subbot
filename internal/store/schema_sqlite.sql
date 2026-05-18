CREATE TABLE IF NOT EXISTS accounts (
  account_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  scanned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_account_latest
  ON scans(account_hash, scanned_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  account_hash TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sender_email TEXT NOT NULL DEFAULT '',
  sender_domain TEXT NOT NULL DEFAULT '',
  list_id TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL,
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  frequency_label TEXT NOT NULL,
  frequency_per_week REAL NOT NULL,
  unsubscribe_methods_json TEXT NOT NULL DEFAULT '[]',
  message_summaries_json TEXT NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_scan_key
  ON subscriptions(scan_id, subscription_key);

CREATE INDEX IF NOT EXISTS idx_subscriptions_account_key
  ON subscriptions(account_hash, subscription_key);

CREATE TABLE IF NOT EXISTS unsubscribe_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_hash TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  method_type TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  attempted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unsubscribe_attempts_account_key
  ON unsubscribe_attempts(account_hash, subscription_key, attempted_at DESC);
