import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AnalysisResult } from '@irrigation/intelligence';

function idFor(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function saveAnalysis(db: DatabaseSync, result: AnalysisResult, executedAt: string): 'inserted' | 'duplicate' | 'no_window' {
  if (!result.trainingStart || !result.trainingEnd) return 'no_window';
  const device = db.prepare('SELECT identity_kind FROM devices WHERE id=?').get(result.deviceId) as { identity_kind: string } | undefined;
  if (!device || device.identity_kind !== (result.source === 'device' ? 'physical' : 'simulator')) throw new Error('Analysis identity mismatch');
  if (result.source === 'simulator' && (!result.runId || !db.prepare('SELECT 1 FROM simulation_runs WHERE id=?').get(result.runId)))
    throw new Error('Analysis run mismatch');
  if (result.source === 'device' && result.runId !== null) throw new Error('Physical analysis cannot link a simulation');
  const prior = db.prepare('SELECT input_row_hash FROM analysis_runs WHERE id=?').get(result.id) as { input_row_hash: string } | undefined;
  if (prior) {
    if (prior.input_row_hash !== result.inputHash) throw new Error('Analysis hash conflict');
    return 'duplicate';
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO analysis_runs(id,device_id,simulation_run_id,source,algorithm_name,algorithm_version,
      config_hash,input_start_at,input_end_at,input_row_hash,sample_count,coverage,executed_at,status,reason_code)
      VALUES(?,?,?,?,'OLS_MAD',?,?,?,?,?,?,?,?,?,?)`).run(result.id, result.deviceId, result.runId,
        result.source, result.algorithmVersion, result.configHash, result.trainingStart, result.trainingEnd,
        result.inputHash, result.sampleCount, result.coverage, executedAt, result.status, result.reason);
    db.prepare(`INSERT INTO predictions(id,analysis_run_id,prediction_type,status,estimated_crossing_at,horizon_ms,
      dry_threshold_percent,slope_pp_per_hour,intercept_pp,r_squared,residual_mad_pp,training_start_at,
      training_end_at,sample_count,created_at) VALUES(?,?,'DRY_THRESHOLD_CROSSING',?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(idFor(`${result.id}:prediction`), result.id, result.status, result.prediction.crossingAt,
        result.prediction.horizonMs, result.prediction.dryThresholdPercent, result.prediction.slopePpPerHour,
        result.prediction.interceptPp, result.prediction.rSquared, result.prediction.residualMadPp,
        result.trainingStart, result.trainingEnd, result.sampleCount, executedAt);
    result.insightsFa.forEach((explanation, index) => db.prepare(`INSERT INTO insights(id,analysis_run_id,insight_type,
      severity,evidence_start_at,evidence_end_at,evidence_summary_json,explanation_fa,recommendation_fa,
      created_at,status,algorithm_version) VALUES(?,? ,?,'info',?,?,?,?,NULL,?,'active',?)`)
      .run(idFor(`${result.id}:insight:${index}`), result.id, result.status === 'VALID' ? 'forecast' : 'data_quality',
        result.trainingStart, result.trainingEnd, JSON.stringify({ sampleCount: result.sampleCount,
          coverage: result.coverage, inputHash: result.inputHash }), explanation, executedAt, result.algorithmVersion));
    result.anomalies.forEach((flag, index) => db.prepare(`INSERT INTO insights(id,analysis_run_id,insight_type,
      severity,evidence_start_at,evidence_end_at,evidence_summary_json,explanation_fa,recommendation_fa,
      created_at,status,algorithm_version) VALUES(?,?,'anomaly',?,?,?,?,?,NULL,?,'active',?)`)
      .run(idFor(`${result.id}:anomaly:${index}`), result.id, flag.severity, flag.evidenceStart,
        flag.evidenceEnd, JSON.stringify(flag), `نامزد ناهنجاری ${flag.type} در داده‌ها دیده شد؛ این تشخیص خرابی نیست.`,
        executedAt, result.algorithmVersion));
    db.exec('COMMIT');
    return 'inserted';
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
