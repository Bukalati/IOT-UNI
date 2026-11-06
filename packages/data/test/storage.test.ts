import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ingestTelemetry, migrate, openDatabase, registerDevice, registerSimulationRun } from '../src/index.ts';

const at = '2026-11-06T15:00:00.000Z';
const physical = { deviceId: 'plant-01', source: 'device' as const, runId: null };
const packet = {
  schemaVersion: 1, deviceId: 'plant-01', bootId: '00000000-0000-4000-8000-000000000001',
  seq: 1, uptimeMs: 10000, sentAt: at, timeTrusted: true, source: 'device',
  payload: { soilRaw: 2000, soilPercent: 40, soilQuality: 'calibrated', soilAcquiredUptimeMs: 9500,
    tankDistanceCm: 12, tankPercent: 60, tankQuality: 'valid', tankAcquiredUptimeMs: 9500,
    pumpOn: false, mode: 'AUTO', state: 'IDLE', settingsRevision: 1, soilCalibrationRevision: 1,
    tankCalibrationRevision: 1 },
};

test('migration enforces foreign keys and source identity', () => {
  const db = openDatabase(); migrate(db);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  registerDevice(db, 'plant-01', 'physical', 'Plant', at);
  assert.throws(() => registerDevice(db, 'plant-01', 'physical', 'Duplicate', at));
  assert.throws(() => db.prepare("INSERT INTO device_boots VALUES('missing','boot',?,NULL)").run(at));
  assert.throws(() => ingestTelemetry(db, { ...packet, source: 'simulator' }, physical, at));
  db.close();
});

test('telemetry deduplicates, alerts on conflict, and keeps acquisition time separate', () => {
  const db = openDatabase(); migrate(db);
  registerDevice(db, 'plant-01', 'physical', 'Plant', at);
  assert.equal(ingestTelemetry(db, packet, physical, at), 'inserted');
  assert.equal(ingestTelemetry(db, packet, physical, at), 'duplicate');
  assert.equal(ingestTelemetry(db, { ...packet, payload: { ...packet.payload, soilPercent: 41 } }, physical, at), 'conflict');
  const row = db.prepare('SELECT measured_at,received_at,soil_percent FROM telemetry').get();
  assert.equal(row?.measured_at, '2026-11-06T14:59:59.500Z');
  assert.equal(row?.received_at, at);
  assert.equal(row?.soil_percent, 40);
  assert.equal(db.prepare('SELECT count(*) n FROM alerts').get()?.n, 1);
  db.close();
});

test('simulated rows require a distinct identity and existing run', () => {
  const db = openDatabase(); migrate(db);
  registerDevice(db, 'sim-plant-01', 'simulator', 'Simulation', at);
  const sim = { ...packet, deviceId: 'sim-plant-01', source: 'simulator', seq: 1 };
  const provenance = { deviceId: 'sim-plant-01', source: 'simulator' as const, runId: 'demo-01' };
  assert.throws(() => ingestTelemetry(db, sim, provenance, at));
  registerSimulationRun(db, { id: 'demo-01', seed: 7, scenario: 'gradual-drying', scenarioVersion: '1', virtualStartAt: at, canonicalHash: 'abc' });
  assert.equal(ingestTelemetry(db, sim, provenance, at), 'inserted');
  assert.equal(db.prepare('SELECT source,simulation_run_id FROM telemetry').get()?.simulation_run_id, 'demo-01');
  db.close();
});

test('replay after database reopen remains one row; gaps stay gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irrigation-db-'));
  const path = join(dir, 'test.sqlite');
  try {
    const db = openDatabase(path); migrate(db);
    registerDevice(db, 'plant-01', 'physical', 'Plant', at);
    assert.equal(ingestTelemetry(db, packet, physical, at), 'inserted');
    db.close();
    const reopened = openDatabase(path); migrate(reopened);
    assert.equal(ingestTelemetry(reopened, packet, physical, at), 'duplicate');
    assert.equal(ingestTelemetry(reopened, { ...packet, seq: 3 }, physical, at), 'inserted');
    assert.deepEqual(reopened.prepare('SELECT seq FROM telemetry ORDER BY seq').all().map(row => row.seq), [1, 3]);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('database constraints reject impossible telemetry, command, and duplicate active alert', () => {
  const db = openDatabase(); migrate(db);
  registerDevice(db, 'plant-01', 'physical', 'Plant', at);
  ingestTelemetry(db, packet, physical, at);
  assert.throws(() => db.prepare(`INSERT INTO commands(id,device_id,target_boot_id,created_at,expires_at,duration_ms,status,source)
    VALUES('x','plant-01',?, ?,?,4000,'queued','device')`).run(packet.bootId, at, at));
  assert.throws(() => db.prepare(`INSERT INTO telemetry(device_id,boot_id,seq,topic,source,uptime_ms,received_at,
    time_trusted,soil_quality,tank_quality,pump_on,mode,state,settings_revision,soil_calibration_revision,
    tank_calibration_revision,payload_hash,packet_json) VALUES('plant-01',?,2,'telemetry','device',0,?,0,
    'calibrated','unknown',0,'AUTO','IDLE',1,1,1,'x','{}')`).run(packet.bootId, at));
  db.prepare("INSERT INTO alerts(device_id,code,severity,opened_at,details_json) VALUES('plant-01','TEST','info',?,'{}')").run(at);
  assert.throws(() => db.prepare("INSERT INTO alerts(device_id,code,severity,opened_at,details_json) VALUES('plant-01','TEST','info',?,'{}')").run(at));
  db.close();
});
