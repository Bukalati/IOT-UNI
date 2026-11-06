import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateScenario } from '../../simulator/src/index.ts';
import { analyze, type Point } from '../../intelligence/src/index.ts';
import { migrate, openDatabase, registerDevice, registerSimulationRun, saveAnalysis } from '../src/index.ts';

test('analysis persists with simulation provenance and no control-table writes', () => {
  const output = generateScenario('gradual-drying', 7);
  const points: Point[] = output.packets.map((packet, index) => ({ id: index + 1,
    deviceId: packet.deviceId, source: 'simulator', runId: output.metadata.runId,
    measuredAt: packet.sentAt, receivedAt: packet.sentAt, soilPercent: packet.payload.soilPercent,
    soilQuality: 'calibrated', calibrationRevision: 1, bootId: packet.bootId,
    seq: packet.seq, timeTrusted: true }));
  const result = analyze({ deviceId: 'sim-plant-01', source: 'simulator', runId: output.metadata.runId, points });
  assert.equal(result.status, 'VALID');
  const db = openDatabase(); migrate(db);
  registerDevice(db, 'sim-plant-01', 'simulator', 'Simulation', output.metadata.virtualStartAt);
  registerSimulationRun(db, { id: output.metadata.runId, seed: 7, scenario: 'gradual-drying',
    scenarioVersion: '1', virtualStartAt: output.metadata.virtualStartAt, canonicalHash: 'fixture' });
  assert.equal(saveAnalysis(db, result, output.metadata.virtualStartAt), 'inserted');
  assert.equal(saveAnalysis(db, result, output.metadata.virtualStartAt), 'duplicate');
  assert.equal(db.prepare('SELECT count(*) n FROM analysis_runs').get()?.n, 1);
  assert.equal(db.prepare('SELECT estimated_crossing_at FROM predictions').get()?.estimated_crossing_at, result.prediction.crossingAt);
  assert.equal(db.prepare('SELECT count(*) n FROM commands').get()?.n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM settings_desired').get()?.n, 0);
  assert.throws(() => db.prepare(`INSERT INTO predictions(id,analysis_run_id,prediction_type,status,horizon_ms,
    dry_threshold_percent,sample_count,created_at) VALUES('bad',?,'DRY_THRESHOLD_CROSSING','VALID',1000,30,0,?)`)
    .run(result.id, output.metadata.virtualStartAt));
  db.close();
});
