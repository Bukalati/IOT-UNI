import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePacket } from '../src/index.ts';

const physical = 'irrigation/v1/devices/plant-01';
const simulated = 'irrigation/v1/simulations/demo-01/devices/sim-plant-01';
const bootId = '00000000-0000-4000-8000-000000000001';
const command = {
  schemaVersion: 1, commandId: '00000000-0000-4000-8000-000000000002', deviceId: 'plant-01',
  targetBootId: bootId, createdAt: '2026-11-06T15:00:00.000Z',
  expiresAt: '2026-11-06T15:00:10.000Z', type: 'WATER_PULSE', payload: { durationMs: 2000 },
};
const telemetry = {
  schemaVersion: 1, deviceId: 'plant-01', bootId, seq: 12, uptimeMs: 120000, sentAt: null,
  timeTrusted: false, source: 'device', payload: {
    soilRaw: 2140, soilPercent: 42, soilQuality: 'calibrated', soilAcquiredUptimeMs: 119500,
    tankDistanceCm: 13.2, tankPercent: 64, tankQuality: 'valid', tankAcquiredUptimeMs: 119400,
    pumpOn: false, mode: 'AUTO', state: 'IDLE', settingsRevision: 1,
    soilCalibrationRevision: 1, tankCalibrationRevision: 1, wifiRssiDbm: -59,
  },
};
function check(topic: string, packet: unknown, retained = false) {
  return validatePacket(topic, Buffer.from(JSON.stringify(packet)), retained);
}

test('accepted v1 telemetry and command packets', () => {
  assert.equal(check(`${physical}/telemetry`, telemetry).ok, true);
  assert.equal(check(`${physical}/commands`, command).ok, true);
});

test('rejects range, expiry, retain, identity and unknown fields', () => {
  assert.equal(check(`${physical}/commands`, { ...command, payload: { durationMs: 4000 } }).ok, false);
  assert.equal(check(`${physical}/commands`, command, true).ok, false);
  assert.equal(check(`${physical}/commands`, { ...command, expiresAt: '2026-11-06T15:00:11.000Z' }).ok, false);
  assert.equal(check(`${physical}/telemetry`, { ...telemetry, source: 'simulator' }).ok, false);
  assert.equal(check(`${physical}/telemetry`, { ...telemetry, extra: 1 }).ok, false);
  assert.equal(check(`${simulated}/telemetry`, telemetry).ok, false);
});

test('rejects invalid quality, timestamps, UTF-8 and oversized payload', () => {
  assert.equal(check(`${physical}/telemetry`, { ...telemetry, payload: { ...telemetry.payload, soilPercent: null } }).ok, false);
  assert.equal(check(`${physical}/telemetry`, { ...telemetry, timeTrusted: true }).ok, false);
  assert.equal(check(`${physical}/telemetry`, { ...telemetry, payload: { ...telemetry.payload, soilAcquiredUptimeMs: 120001 } }).ok, false);
  assert.equal(validatePacket(`${physical}/telemetry`, Buffer.from([0xff])).ok, false);
  assert.equal(validatePacket(`${physical}/telemetry`, Buffer.alloc(2049)).ok, false);
  assert.equal(check(`${physical}/telemetry`, { ...telemetry, payload: { ...telemetry.payload, soilAcquiredUptimeMs: 105000 } }).ok, false);
  assert.equal(check(`${physical}/telemetry`, { ...telemetry, sentAt: '2026-99-99T15:00:00.000Z', timeTrusted: true }).ok, false);
});

test('status, event, ACK and settings schemas classify complete v1 packets', () => {
  const sequence = { schemaVersion: 1, deviceId: 'plant-01', bootId, seq: 13, uptimeMs: 120100,
    sentAt: null, timeTrusted: false, source: 'device' };
  const status = { schemaVersion: 1, deviceId: 'plant-01', source: 'device', payload: {
    availability: 'offline', reason: 'LWT', firmwareVersion: null, bootId, publishedAt: null } };
  const event = { ...sequence, payload: { eventId: '00000000-0000-4000-8000-000000000003',
    eventType: 'PULSE_ENDED', pulseId: '00000000-0000-4000-8000-000000000004', commandId: null,
    triggerSource: 'AUTO', stateFrom: 'WATERING', stateTo: 'SOAKING', actualMs: 2000, reasonCode: null } };
  const ack = { ...sequence, seq: 14, payload: { commandId: command.commandId, status: 'accepted',
    reasonCode: null, pulseId: '00000000-0000-4000-8000-000000000004' } };
  const values = { mode: 'AUTO', dryThresholdPercent: 30, wetThresholdPercent: 45,
    manualWetCutoffPercent: 45, sampleIntervalMs: 5000, maxSampleAgeMs: 15000,
    defaultPulseMs: 2000, maxPulseMs: 3000, soakMs: 60000, maxPulsesPerCycle: 3,
    maxRolling24hRuntimeMs: 20000, tankMinPercent: 10, consecutiveDrySamples: 3 };
  const desired = { schemaVersion: 1, deviceId: 'plant-01', revision: 1, values,
    issuedAt: '2026-11-06T15:00:00.000Z' };
  const reported = { schemaVersion: 1, deviceId: 'plant-01', source: 'device', revision: 1,
    values, calibrationRevision: 1, rejectedRevision: null, reasonCode: null };
  for (const [suffix, packet] of [
    ['status', status], ['events', event], ['acks', ack], ['settings/desired', desired], ['settings/reported', reported],
  ] as const) assert.equal(check(`${physical}/${suffix}`, packet).ok, true, suffix);
  assert.equal(check(`${physical}/settings/desired`, { ...desired, values: { ...values, maxPulseMs: 4000 } }).ok, false);
  assert.equal(check(`${physical}/acks`, { ...ack, payload: { ...ack.payload, status: 'watered' } }).ok, false);
});
