PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY NOT NULL, seed INTEGER NOT NULL, scenario TEXT NOT NULL,
  scenario_version TEXT NOT NULL, virtual_start_at TEXT NOT NULL, canonical_hash TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0), identity_kind TEXT NOT NULL CHECK(identity_kind IN ('physical','simulator')),
  display_name TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS device_status (
  device_id TEXT PRIMARY KEY, availability TEXT NOT NULL CHECK(availability IN ('online','offline')),
  boot_id TEXT, reason TEXT NOT NULL, received_at TEXT NOT NULL, last_live_at TEXT,
  retained INTEGER NOT NULL CHECK(retained IN (0,1)),
  FOREIGN KEY(device_id) REFERENCES devices(id)
) STRICT;
CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS device_boots (
  device_id TEXT NOT NULL, boot_id TEXT NOT NULL, first_seen_at TEXT NOT NULL,
  device_started_at TEXT, PRIMARY KEY(device_id,boot_id),
  FOREIGN KEY(device_id) REFERENCES devices(id)
) STRICT;
CREATE TABLE IF NOT EXISTS packet_ledger (
  device_id TEXT NOT NULL, boot_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('telemetry','events','acks')),
  payload_hash TEXT NOT NULL, PRIMARY KEY(device_id,boot_id,seq),
  FOREIGN KEY(device_id,boot_id) REFERENCES device_boots(device_id,boot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, boot_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 4294967295), topic TEXT NOT NULL CHECK(topic='telemetry'),
  source TEXT NOT NULL CHECK(source IN ('device','simulator')), simulation_run_id TEXT,
  uptime_ms INTEGER NOT NULL CHECK(uptime_ms>=0), sent_at TEXT, measured_at TEXT, tank_measured_at TEXT,
  received_at TEXT NOT NULL, time_trusted INTEGER NOT NULL CHECK(time_trusted IN (0,1)),
  soil_raw INTEGER CHECK(soil_raw BETWEEN 0 AND 4095), soil_percent REAL CHECK(soil_percent BETWEEN 0 AND 100),
  soil_quality TEXT NOT NULL CHECK(soil_quality IN ('calibrated','uncalibrated','invalid','stale')),
  tank_distance_cm REAL CHECK(tank_distance_cm>=0), tank_percent REAL CHECK(tank_percent BETWEEN 0 AND 100),
  tank_quality TEXT NOT NULL CHECK(tank_quality IN ('valid','uncalibrated','unknown','stale')),
  pump_on INTEGER NOT NULL CHECK(pump_on IN (0,1)), mode TEXT NOT NULL CHECK(mode IN ('AUTO','MANUAL','OFF')),
  state TEXT NOT NULL CHECK(state IN ('IDLE','WATERING','SOAKING','LOCKOUT','FAULT')),
  settings_revision INTEGER NOT NULL CHECK(settings_revision>=0),
  soil_calibration_revision INTEGER NOT NULL CHECK(soil_calibration_revision>=0),
  tank_calibration_revision INTEGER NOT NULL CHECK(tank_calibration_revision>=0),
  payload_hash TEXT NOT NULL, packet_json TEXT NOT NULL CHECK(json_valid(packet_json)),
  CHECK((time_trusted=1 AND sent_at IS NOT NULL) OR (time_trusted=0 AND sent_at IS NULL AND measured_at IS NULL)),
  CHECK((soil_quality='calibrated' AND soil_percent IS NOT NULL) OR (soil_quality!='calibrated' AND soil_percent IS NULL)),
  CHECK((tank_quality='valid' AND tank_percent IS NOT NULL) OR (tank_quality!='valid' AND tank_percent IS NULL)),
  CHECK((source='device' AND simulation_run_id IS NULL) OR (source='simulator' AND simulation_run_id IS NOT NULL)),
  UNIQUE(device_id,boot_id,seq,topic),
  FOREIGN KEY(device_id,boot_id) REFERENCES device_boots(device_id,boot_id),
  FOREIGN KEY(simulation_run_id) REFERENCES simulation_runs(id)
) STRICT;
CREATE INDEX IF NOT EXISTS telemetry_time ON telemetry(device_id,measured_at);
CREATE INDEX IF NOT EXISTS telemetry_receipt ON telemetry(device_id,received_at DESC);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, target_boot_id TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 1 AND 3000),
  status TEXT NOT NULL CHECK(status IN ('queued','published','accepted','completed','rejected','failed','unknown')),
  reason_code TEXT, source TEXT NOT NULL CHECK(source IN ('device','simulator')),
  FOREIGN KEY(device_id) REFERENCES devices(id), FOREIGN KEY(device_id,target_boot_id) REFERENCES device_boots(device_id,boot_id)
) STRICT;
CREATE INDEX IF NOT EXISTS commands_recent ON commands(device_id,created_at DESC);
CREATE TABLE IF NOT EXISTS command_outbox (
  command_id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  published_at TEXT, FOREIGN KEY(command_id) REFERENCES commands(id)
) STRICT;
CREATE TABLE IF NOT EXISTS command_acks (
  id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, boot_id TEXT NOT NULL, seq INTEGER NOT NULL,
  topic TEXT NOT NULL CHECK(topic='acks'), command_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('accepted','rejected','completed','failed')),
  reason_code TEXT, pulse_id TEXT, received_at TEXT NOT NULL, payload_hash TEXT NOT NULL,
  UNIQUE(device_id,boot_id,seq,topic), FOREIGN KEY(command_id) REFERENCES commands(id),
  FOREIGN KEY(device_id,boot_id) REFERENCES device_boots(device_id,boot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS irrigation_events (
  id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, boot_id TEXT NOT NULL, seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL CHECK(event_type IN ('PULSE_STARTED','PULSE_ENDED','STATE_CHANGED','FAULT_RAISED','FAULT_CLEARED')),
  pulse_id TEXT, command_id TEXT, trigger_source TEXT NOT NULL CHECK(trigger_source IN ('AUTO','BUTTON','WEB')),
  actual_ms INTEGER CHECK(actual_ms>=0), reason_code TEXT, received_at TEXT NOT NULL, payload_hash TEXT NOT NULL,
  UNIQUE(device_id,boot_id,seq), FOREIGN KEY(device_id,boot_id) REFERENCES device_boots(device_id,boot_id),
  FOREIGN KEY(command_id) REFERENCES commands(id)
) STRICT;
CREATE INDEX IF NOT EXISTS events_pulse ON irrigation_events(device_id,boot_id,pulse_id);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
  opened_at TEXT NOT NULL, resolved_at TEXT, details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  CHECK(resolved_at IS NULL OR resolved_at>=opened_at), FOREIGN KEY(device_id) REFERENCES devices(id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_active ON alerts(device_id,code) WHERE resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS settings_desired (
  device_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  issued_at TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected')),
  PRIMARY KEY(device_id,revision), FOREIGN KEY(device_id) REFERENCES devices(id)
) STRICT;
CREATE TABLE IF NOT EXISTS settings_reported (
  device_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), values_json TEXT NOT NULL CHECK(json_valid(values_json)),
  calibration_revision INTEGER NOT NULL CHECK(calibration_revision>=0), rejected_revision INTEGER, reason_code TEXT,
  received_at TEXT NOT NULL, PRIMARY KEY(device_id,revision,received_at), FOREIGN KEY(device_id) REFERENCES devices(id)
) STRICT;
CREATE TABLE IF NOT EXISTS calibrations (
  device_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('soil','tank')), revision INTEGER NOT NULL CHECK(revision>0),
  endpoint_a REAL, endpoint_b REAL, status TEXT NOT NULL CHECK(status IN ('valid','invalid','uncalibrated')),
  reported_at TEXT NOT NULL, CHECK(status!='valid' OR (endpoint_a IS NOT NULL AND endpoint_b IS NOT NULL AND endpoint_a!=endpoint_b)),
  PRIMARY KEY(device_id,kind,revision), FOREIGN KEY(device_id) REFERENCES devices(id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS telemetry_identity BEFORE INSERT ON telemetry BEGIN
  SELECT CASE WHEN (SELECT identity_kind FROM devices WHERE id=NEW.device_id) !=
    CASE NEW.source WHEN 'device' THEN 'physical' ELSE 'simulator' END
    THEN RAISE(ABORT,'source identity mismatch') END;
END;
