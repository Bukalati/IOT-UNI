CREATE TABLE IF NOT EXISTS settings_outbox (
  device_id TEXT NOT NULL, revision INTEGER NOT NULL, topic TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), published_at TEXT,
  PRIMARY KEY(device_id,revision),
  FOREIGN KEY(device_id,revision) REFERENCES settings_desired(device_id,revision)
) STRICT;
CREATE INDEX IF NOT EXISTS settings_outbox_pending ON settings_outbox(published_at,device_id,revision);
