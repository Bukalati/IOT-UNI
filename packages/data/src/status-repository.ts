import type { DatabaseSync } from 'node:sqlite';

export function recordStatus(db: DatabaseSync, status: {
  deviceId: string; availability: 'online' | 'offline'; bootId: string | null;
  reason: string; receivedAt: string; retained: boolean;
}): void {
  const prior = db.prepare('SELECT last_live_at FROM device_status WHERE device_id=?')
    .get(status.deviceId) as { last_live_at: string | null } | undefined;
  const liveAt = !status.retained && status.availability === 'online' ? status.receivedAt : prior?.last_live_at ?? null;
  db.prepare(`INSERT INTO device_status(device_id,availability,boot_id,reason,received_at,last_live_at,retained)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET availability=excluded.availability,
    boot_id=excluded.boot_id,reason=excluded.reason,received_at=excluded.received_at,
    last_live_at=excluded.last_live_at,retained=excluded.retained`)
    .run(status.deviceId, status.availability, status.bootId, status.reason, status.receivedAt, liveAt, status.retained ? 1 : 0);
}

export function noteLivePacket(db: DatabaseSync, deviceId: string, bootId: string, receivedAt: string): void {
  db.prepare(`INSERT INTO device_status(device_id,availability,boot_id,reason,received_at,last_live_at,retained)
    VALUES(?,'online',?,'PACKET',?,?,0) ON CONFLICT(device_id) DO UPDATE SET availability='online',
    boot_id=excluded.boot_id,reason='PACKET',received_at=excluded.received_at,
    last_live_at=excluded.last_live_at,retained=0`).run(deviceId, bootId, receivedAt, receivedAt);
}

export function currentStatus(db: DatabaseSync, deviceId: string, now: string): {
  availability: 'online' | 'offline' | 'stale'; bootId: string | null; ageMs: number | null; lastLiveAt: string | null;
} {
  const row = db.prepare('SELECT availability,boot_id,last_live_at FROM device_status WHERE device_id=?')
    .get(deviceId) as { availability: 'online' | 'offline'; boot_id: string | null; last_live_at: string | null } | undefined;
  const ageMs = row?.last_live_at ? Date.parse(now) - Date.parse(row.last_live_at) : null;
  const availability = row?.availability === 'offline' ? 'offline'
    : ageMs !== null && ageMs >= 0 && ageMs < 30000 ? 'online' : 'stale';
  return { availability, bootId: row?.boot_id ?? null, ageMs, lastLiveAt: row?.last_live_at ?? null };
}
