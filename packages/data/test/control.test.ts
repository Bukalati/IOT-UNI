import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPacket, markPublished, migrate, openDatabase, pendingCommands,
  queueCommand, recordAck, recordEvent, registerDevice, saveDesiredSettings, saveReportedSettings,
  queueDesiredSettings, pendingDesiredSettings, markDesiredSettingsPublished, requestDesiredSettingsReplay } from '../src/index.ts';

const at = '2026-11-06T15:00:00.000Z';
const bootId = '00000000-0000-4000-8000-000000000001';
const commandId = '00000000-0000-4000-8000-000000000002';
function readyDb() {
  const db = openDatabase(); migrate(db);
  registerDevice(db, 'plant-01', 'physical', 'Plant', at);
  db.prepare('INSERT INTO device_boots(device_id,boot_id,first_seen_at) VALUES(?,?,?)').run('plant-01', bootId, at);
  return db;
}
const commandPacket = { schemaVersion: 1, commandId, deviceId: 'plant-01', targetBootId: bootId,
  createdAt: at, expiresAt: '2026-11-06T15:00:10.000Z', type: 'WATER_PULSE', payload: { durationMs: 2000 } };
const command = { id: commandId, deviceId: 'plant-01', targetBootId: bootId, createdAt: at,
  expiresAt: '2026-11-06T15:00:10.000Z', durationMs: 2000, source: 'device' as const,
  topic: 'irrigation/v1/devices/plant-01/commands', packet: commandPacket };

test('command and outbox are atomic and never duplicate an ID', () => {
  const db = readyDb();
  queueCommand(db, command);
  assert.equal(pendingCommands(db, at).length, 1);
  assert.throws(() => queueCommand(db, command));
  assert.equal(db.prepare('SELECT count(*) n FROM command_outbox').get()?.n, 1);
  assert.equal(markPublished(db, commandId, at), true);
  assert.equal(markPublished(db, commandId, at), false);
  assert.equal(pendingCommands(db, at).length, 0);
  db.close();
});

test('ACK dedup and terminal status never regress', () => {
  const db = readyDb(); queueCommand(db, command); markPublished(db, commandId, at);
  const accepted = { deviceId: 'plant-01', bootId, seq: 1, commandId,
    status: 'accepted' as const, reasonCode: null, pulseId: null, receivedAt: at, payloadHash: hashPacket({ status: 'accepted' }) };
  assert.equal(recordAck(db, accepted), 'advanced');
  assert.equal(recordAck(db, accepted), 'duplicate');
  assert.equal(recordAck(db, { ...accepted, payloadHash: 'different' }), 'conflict');
  const pulseId = '00000000-0000-4000-8000-000000000005';
  assert.equal(recordAck(db, { ...accepted, seq: 2, status: 'completed', pulseId,
    payloadHash: hashPacket({ status: 'completed' }) }), 'held');
  assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(commandId)?.status, 'accepted');
  assert.equal(recordEvent(db, { deviceId: 'plant-01', bootId, seq: 4,
    eventId: '00000000-0000-4000-8000-000000000006', eventType: 'PULSE_ENDED',
    pulseId, commandId, triggerSource: 'WEB', actualMs: 2000, reasonCode: null,
    receivedAt: at, payloadHash: hashPacket({ eventType: 'PULSE_ENDED' }) }), 'inserted');
  assert.equal(recordAck(db, { ...accepted, seq: 3 }), 'held');
  assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(commandId)?.status, 'completed');
  db.close();
});

test('out-of-order completion reconciles after accepted and pulse end; cross-topic seq conflicts', () => {
  const db = readyDb(); queueCommand(db, command); markPublished(db, commandId, at);
  const pulseId = '00000000-0000-4000-8000-000000000005';
  const complete = { deviceId: 'plant-01', bootId, seq: 6, commandId, status: 'completed' as const,
    reasonCode: null, pulseId, receivedAt: at, payloadHash: hashPacket({ status: 'completed' }) };
  assert.equal(recordAck(db, complete), 'held');
  assert.equal(recordEvent(db, { deviceId: 'plant-01', bootId, seq: 7,
    eventId: '00000000-0000-4000-8000-000000000006', eventType: 'PULSE_ENDED',
    pulseId, commandId, triggerSource: 'WEB', actualMs: 1900, reasonCode: null,
    receivedAt: at, payloadHash: hashPacket({ eventType: 'PULSE_ENDED' }) }), 'inserted');
  assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(commandId)?.status, 'published');
  assert.equal(recordAck(db, { ...complete, seq: 8, status: 'accepted', payloadHash: hashPacket({ status: 'accepted' }) }), 'advanced');
  assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(commandId)?.status, 'completed');
  assert.equal(recordEvent(db, { deviceId: 'plant-01', bootId, seq: 6,
    eventId: '00000000-0000-4000-8000-000000000009', eventType: 'STATE_CHANGED',
    pulseId: null, commandId: null, triggerSource: 'WEB', actualMs: null, reasonCode: null,
    receivedAt: at, payloadHash: 'different' }), 'conflict');
  db.close();
});

test('desired settings only become applied after matching report', () => {
  const db = readyDb();
  const values = { mode: 'OFF', dryThresholdPercent: 30 };
  saveDesiredSettings(db, 'plant-01', 1, values, at, at);
  assert.equal(db.prepare('SELECT status FROM settings_desired').get()?.status, 'pending');
  assert.equal(saveReportedSettings(db, 'plant-01', 1, { mode: 'AUTO' }, 1, null, null, at), 'mismatch');
  assert.equal(db.prepare('SELECT status FROM settings_desired').get()?.status, 'pending');
  assert.equal(saveReportedSettings(db, 'plant-01', 1, values, 1, null, null, '2026-11-06T15:00:01.000Z'), 'applied');
  assert.equal(db.prepare('SELECT status FROM settings_desired').get()?.status, 'applied');
  assert.throws(() => saveDesiredSettings(db, 'plant-01', 1, values, at, at));
  db.close();
});

test('desired settings publish intent is durable and replayed at the same revision after live reconnect', () => {
  const db = readyDb();
  const values = { mode: 'OFF' };
  const packet = { schemaVersion: 1, deviceId: 'plant-01', revision: 1, values, issuedAt: at };
  const topic = 'irrigation/v1/devices/plant-01/settings/desired';
  assert.equal(queueDesiredSettings(db, 'plant-01', values, at, topic, packet), 1);
  assert.equal(pendingDesiredSettings(db).length, 1);
  assert.equal(markDesiredSettingsPublished(db, 'plant-01', 1, at), true);
  assert.equal(pendingDesiredSettings(db).length, 0);
  assert.equal(requestDesiredSettingsReplay(db, 'plant-01'), true);
  assert.equal(pendingDesiredSettings(db).length, 1);
  assert.equal(pendingDesiredSettings(db)[0].packet, JSON.stringify(packet));
  db.close();
});
