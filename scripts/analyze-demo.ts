import { resolve } from 'node:path';
import { migrate, openDatabase, saveAnalysis } from '../packages/data/src/index.ts';
import { analyze, type Point } from '../packages/intelligence/src/index.ts';

const db = openDatabase(process.env.SQLITE_PATH ?? resolve('data/demo.sqlite'));
migrate(db);
const runs = db.prepare('SELECT id,scenario FROM simulation_runs ORDER BY scenario').all();
const summary: { runId: string; scenario: string; status: string; reason: string | null;
  sampleCount: number; anomalies: number; persistence: string }[] = [];
for (const run of runs) {
  const rows = db.prepare(`SELECT id,device_id,boot_id,seq,measured_at,received_at,soil_percent,soil_quality,
    soil_calibration_revision,time_trusted,pump_on FROM telemetry WHERE simulation_run_id=? ORDER BY measured_at,id`).all(run.id as string);
  const points: Point[] = rows.map(row => ({ id: row.id as number, deviceId: row.device_id as string,
    source: 'simulator', runId: run.id as string, measuredAt: row.measured_at as string | null,
    receivedAt: row.received_at as string, soilPercent: row.soil_percent as number | null,
    soilQuality: row.soil_quality as string, calibrationRevision: row.soil_calibration_revision as number,
    bootId: row.boot_id as string, seq: row.seq as number, timeTrusted: row.time_trusted === 1 }));
  const asOf = points.filter(point => point.measuredAt).at(-1)?.measuredAt;
  const result = analyze({ deviceId: 'sim-plant-01', source: 'simulator', runId: run.id as string, points,
    discontinuities: rows.filter(row => row.pump_on === 1 && row.measured_at).map(row => row.measured_at as string),
    asOf: asOf ?? undefined });
  const persistence = saveAnalysis(db, result, asOf ?? '2026-11-06T08:00:00.000Z');
  summary.push({ runId: run.id as string, scenario: run.scenario as string, status: result.status,
    reason: result.reason, sampleCount: result.sampleCount, anomalies: result.anomalies.length, persistence });
}
console.log(JSON.stringify(summary, null, 2));
db.close();
