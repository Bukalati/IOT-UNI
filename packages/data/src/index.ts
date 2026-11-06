import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
export * from './control-repository.js';
export * from './status-repository.js';
export * from './analysis-repository.js';

export type Provenance = { deviceId: string; source: 'device' | 'simulator'; runId: string | null };
export type IngestResult = 'inserted' | 'duplicate' | 'conflict';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function hashPacket(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function openDatabase(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  return db;
}

export function migrate(db: DatabaseSync): void {
  const sql = readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
  db.exec(sql);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
  db.exec(readFileSync(new URL('../migrations/002_analytics.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,?)').run(new Date().toISOString());
}

export function registerSimulationRun(db: DatabaseSync, run: {
  id: string; seed: number; scenario: string; scenarioVersion: string; virtualStartAt: string; canonicalHash: string;
}): void {
  db.prepare(`INSERT INTO simulation_runs(id,seed,scenario,scenario_version,virtual_start_at,canonical_hash)
    VALUES(?,?,?,?,?,?)`).run(run.id, run.seed, run.scenario, run.scenarioVersion, run.virtualStartAt, run.canonicalHash);
}

export function registerDevice(db: DatabaseSync, id: string, kind: 'physical' | 'simulator', name: string, at: string): void {
  db.prepare('INSERT INTO devices(id,identity_kind,display_name,created_at) VALUES(?,?,?,?)').run(id, kind, name, at);
}

export function ingestTelemetry(db: DatabaseSync, packet: Record<string, unknown>, provenance: Provenance, receivedAt: string): IngestResult {
  const payload = packet.payload as Record<string, unknown>;
  const deviceId = packet.deviceId as string;
  const bootId = packet.bootId as string;
  const seq = packet.seq as number;
  if (deviceId !== provenance.deviceId || packet.source !== provenance.source ||
      (provenance.source === 'simulator' && !provenance.runId) ||
      (provenance.source === 'device' && provenance.runId !== null)) throw new Error('Unvalidated provenance');
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error('Invalid receipt timestamp');
  const hash = hashPacket(packet);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO device_boots(device_id,boot_id,first_seen_at) VALUES(?,?,?)').run(deviceId, bootId, receivedAt);
    const prior = db.prepare('SELECT kind,payload_hash FROM packet_ledger WHERE device_id=? AND boot_id=? AND seq=?').get(deviceId, bootId, seq) as { kind: string; payload_hash: string } | undefined;
    if (prior) {
      if (prior.kind === 'telemetry' && prior.payload_hash === hash) { db.exec('COMMIT'); return 'duplicate'; }
      db.prepare(`INSERT OR IGNORE INTO alerts(device_id,code,severity,opened_at,details_json)
        VALUES(?,'SEQ_CONFLICT','critical',?,?)`).run(deviceId, receivedAt, JSON.stringify({ bootId, seq }));
      db.exec('COMMIT');
      return 'conflict';
    }
    const measuredAt = deriveTime(packet, payload.soilAcquiredUptimeMs);
    const tankMeasuredAt = deriveTime(packet, payload.tankAcquiredUptimeMs);
    db.prepare(`INSERT INTO packet_ledger(device_id,boot_id,seq,kind,payload_hash) VALUES(?,?,?,'telemetry',?)`)
      .run(deviceId, bootId, seq, hash);
    db.prepare(`INSERT INTO telemetry(device_id,boot_id,seq,topic,source,simulation_run_id,uptime_ms,sent_at,
      measured_at,tank_measured_at,received_at,time_trusted,soil_raw,soil_percent,soil_quality,tank_distance_cm,
      tank_percent,tank_quality,pump_on,mode,state,settings_revision,soil_calibration_revision,tank_calibration_revision,
      payload_hash,packet_json) VALUES(?,?,?,'telemetry',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(deviceId, bootId, seq, provenance.source, provenance.runId, packet.uptimeMs as number, packet.sentAt as string | null,
        measuredAt, tankMeasuredAt, receivedAt, packet.timeTrusted ? 1 : 0, payload.soilRaw as number | null,
        payload.soilPercent as number | null, payload.soilQuality as string, payload.tankDistanceCm as number | null,
        payload.tankPercent as number | null, payload.tankQuality as string, payload.pumpOn ? 1 : 0,
        payload.mode as string, payload.state as string, payload.settingsRevision as number,
        payload.soilCalibrationRevision as number, payload.tankCalibrationRevision as number, hash, canonical(packet));
    db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(receivedAt, deviceId);
    db.prepare(`INSERT INTO device_status(device_id,availability,boot_id,reason,received_at,last_live_at,retained)
      VALUES(?,'online',?,'PACKET',?,?,0) ON CONFLICT(device_id) DO UPDATE SET availability='online',
      boot_id=excluded.boot_id,reason='PACKET',received_at=excluded.received_at,
      last_live_at=excluded.last_live_at,retained=0`).run(deviceId, bootId, receivedAt, receivedAt);
    db.exec('COMMIT');
    return 'inserted';
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deriveTime(packet: Record<string, unknown>, acquiredUptime: unknown): string | null {
  if (!packet.timeTrusted || typeof packet.sentAt !== 'string' || typeof acquiredUptime !== 'number') return null;
  const age = (packet.uptimeMs as number) - acquiredUptime;
  if (age < 0 || age >= 15000) return null;
  return new Date(Date.parse(packet.sentAt) - age).toISOString();
}
