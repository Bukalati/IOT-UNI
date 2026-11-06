CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, simulation_run_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('device','simulator')),
  algorithm_name TEXT NOT NULL, algorithm_version TEXT NOT NULL, config_hash TEXT NOT NULL,
  input_start_at TEXT NOT NULL, input_end_at TEXT NOT NULL,
  input_row_hash TEXT NOT NULL, sample_count INTEGER NOT NULL CHECK(sample_count>=0),
  coverage REAL CHECK(coverage BETWEEN 0 AND 1), executed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('VALID','INSUFFICIENT_DATA','UNRELIABLE_TREND','ERROR')),
  reason_code TEXT, CHECK(input_start_at<=input_end_at),
  CHECK((source='device' AND simulation_run_id IS NULL) OR (source='simulator' AND simulation_run_id IS NOT NULL)),
  FOREIGN KEY(device_id) REFERENCES devices(id), FOREIGN KEY(simulation_run_id) REFERENCES simulation_runs(id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS analysis_physical_key ON analysis_runs(device_id,algorithm_name,algorithm_version,config_hash,input_row_hash) WHERE source='device';
CREATE UNIQUE INDEX IF NOT EXISTS analysis_sim_key ON analysis_runs(simulation_run_id,device_id,algorithm_name,algorithm_version,config_hash,input_row_hash) WHERE source='simulator';
CREATE INDEX IF NOT EXISTS analysis_recent ON analysis_runs(device_id,executed_at DESC);
CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY NOT NULL, analysis_run_id TEXT NOT NULL UNIQUE,
  prediction_type TEXT NOT NULL CHECK(prediction_type='DRY_THRESHOLD_CROSSING'),
  status TEXT NOT NULL CHECK(status IN ('VALID','INSUFFICIENT_DATA','UNRELIABLE_TREND')),
  estimated_crossing_at TEXT, horizon_ms INTEGER NOT NULL CHECK(horizon_ms BETWEEN 1 AND 86400000),
  dry_threshold_percent REAL NOT NULL CHECK(dry_threshold_percent BETWEEN 0 AND 100),
  slope_pp_per_hour REAL, intercept_pp REAL, r_squared REAL CHECK(r_squared BETWEEN 0 AND 1),
  residual_mad_pp REAL CHECK(residual_mad_pp>=0), training_start_at TEXT, training_end_at TEXT,
  sample_count INTEGER NOT NULL CHECK(sample_count>=0), created_at TEXT NOT NULL,
  CHECK((status='VALID' AND estimated_crossing_at IS NOT NULL AND slope_pp_per_hour IS NOT NULL AND r_squared IS NOT NULL)
    OR (status!='VALID' AND estimated_crossing_at IS NULL)),
  FOREIGN KEY(analysis_run_id) REFERENCES analysis_runs(id)
) STRICT;
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY NOT NULL, analysis_run_id TEXT NOT NULL,
  insight_type TEXT NOT NULL CHECK(insight_type IN ('trend','forecast','anomaly','data_quality')),
  severity TEXT NOT NULL CHECK(severity IN ('info','warning')),
  evidence_start_at TEXT NOT NULL, evidence_end_at TEXT NOT NULL,
  evidence_summary_json TEXT NOT NULL CHECK(json_valid(evidence_summary_json) AND length(evidence_summary_json)<=4096),
  explanation_fa TEXT NOT NULL, recommendation_fa TEXT, created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','superseded','dismissed')),
  algorithm_version TEXT NOT NULL,
  CHECK(evidence_start_at<=evidence_end_at), FOREIGN KEY(analysis_run_id) REFERENCES analysis_runs(id)
) STRICT;
CREATE INDEX IF NOT EXISTS insights_recent ON insights(analysis_run_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS analysis_identity BEFORE INSERT ON analysis_runs BEGIN
  SELECT CASE WHEN (SELECT identity_kind FROM devices WHERE id=NEW.device_id) !=
    CASE NEW.source WHEN 'device' THEN 'physical' ELSE 'simulator' END
    THEN RAISE(ABORT,'analysis identity mismatch') END;
END;
