CREATE TABLE IF NOT EXISTS scans (
  id BIGSERIAL PRIMARY KEY,
  account_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_account_latest
  ON scans(account_hash, scanned_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  scan_id BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  account_hash TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sender_email TEXT NOT NULL DEFAULT '',
  sender_domain TEXT NOT NULL DEFAULT '',
  list_id TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL,
  first_received_at TIMESTAMPTZ NOT NULL,
  last_received_at TIMESTAMPTZ NOT NULL,
  frequency_label TEXT NOT NULL,
  frequency_per_week DOUBLE PRECISION NOT NULL,
  unsubscribe_methods_json JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_scan_key
  ON subscriptions(scan_id, subscription_key);

CREATE INDEX IF NOT EXISTS idx_subscriptions_account_key
  ON subscriptions(account_hash, subscription_key);

CREATE TABLE IF NOT EXISTS unsubscribe_attempts (
  id BIGSERIAL PRIMARY KEY,
  account_hash TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  method_type TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  attempted_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unsubscribe_attempts_account_key
  ON unsubscribe_attempts(account_hash, subscription_key, attempted_at DESC);
