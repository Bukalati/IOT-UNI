import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentStatus, migrate, openDatabase, recordStatus, registerDevice } from '../src/index.ts';

test('retained online cannot prove freshness; threshold is exclusive at 30 seconds', () => {
  const db = openDatabase(); migrate(db);
  registerDevice(db, 'plant-01', 'physical', 'Plant', '2026-11-06T15:00:00.000Z');
  recordStatus(db, { deviceId: 'plant-01', availability: 'online', bootId: 'boot',
    reason: 'CONNECTED', receivedAt: '2026-11-06T15:00:00.000Z', retained: true });
  assert.equal(currentStatus(db, 'plant-01', '2026-11-06T15:00:00.000Z').availability, 'stale');
  recordStatus(db, { deviceId: 'plant-01', availability: 'online', bootId: 'boot',
    reason: 'CONNECTED', receivedAt: '2026-11-06T15:00:01.000Z', retained: false });
  assert.equal(currentStatus(db, 'plant-01', '2026-11-06T15:00:30.999Z').availability, 'online');
  assert.equal(currentStatus(db, 'plant-01', '2026-11-06T15:00:31.000Z').availability, 'stale');
  recordStatus(db, { deviceId: 'plant-01', availability: 'offline', bootId: 'boot',
    reason: 'LWT', receivedAt: '2026-11-06T15:00:32.000Z', retained: true });
  assert.equal(currentStatus(db, 'plant-01', '2026-11-06T15:00:33.000Z').availability, 'offline');
  db.close();
});
