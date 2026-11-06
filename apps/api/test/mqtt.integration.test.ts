import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { connect } from 'mqtt';
import { migrate, openDatabase, registerDevice } from '@irrigation/data';
import { connectBroker } from '../src/mqtt-service.ts';

test('Mosquitto transports physical telemetry into validated SQLite', { skip: process.env.RUN_MQTT_INTEGRATION !== '1' }, async () => {
  const credentials = JSON.parse(readFileSync(new URL('../../../broker/secrets/test-credentials.json', import.meta.url), 'utf8')) as Record<string, string>;
  const db = openDatabase(); migrate(db);
  registerDevice(db, 'plant-01', 'physical', 'Plant', new Date().toISOString());
  const notices: string[] = [];
  const broker = connectBroker({ url: 'mqtt://127.0.0.1:1883', username: 'backend', password: credentials.backend,
    db, onNotice: notice => notices.push(notice.result) });
  const device = connect('mqtt://127.0.0.1:1883', { username: 'device-plant-01',
    password: credentials['device-plant-01'], protocolVersion: 4, clean: true });
  try {
    await Promise.all([new Promise<void>(resolve => broker.client.once('connect', () => resolve())),
      new Promise<void>(resolve => device.once('connect', () => resolve()))]);
    await delay(200);
    const packet = { schemaVersion: 1, deviceId: 'plant-01', bootId: '00000000-0000-4000-8000-000000000001',
      seq: 1, uptimeMs: 5000, sentAt: null, timeTrusted: false, source: 'device', payload: {
        soilRaw: 2000, soilPercent: 40, soilQuality: 'calibrated', soilAcquiredUptimeMs: 5000,
        tankDistanceCm: 10, tankPercent: 70, tankQuality: 'valid', tankAcquiredUptimeMs: 5000,
        pumpOn: false, mode: 'OFF', state: 'IDLE', settingsRevision: 1,
        soilCalibrationRevision: 1, tankCalibrationRevision: 1 } };
    await new Promise<void>((resolve, reject) => device.publish('irrigation/v1/devices/plant-01/telemetry',
      JSON.stringify(packet), { qos: 1, retain: false }, error => error ? reject(error) : resolve()));
    for (let attempt = 0; attempt < 40 && notices.length === 0; attempt++) await delay(50);
    assert.ok(notices.includes('inserted'), `notices=${notices.join(',')}`);
    assert.equal(db.prepare('SELECT count(*) n FROM telemetry').get()?.n, 1);
    assert.equal(db.prepare('SELECT source FROM telemetry').get()?.source, 'device');
  } finally {
    device.end(true); broker.client.end(true); db.close();
  }
});
