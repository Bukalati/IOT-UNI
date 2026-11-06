import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingestTelemetry, openDatabase, registerDevice, registerSimulationRun } from '@irrigation/data';
import { generateScenario } from '../../../packages/simulator/src/index.ts';
import { buildApp, hashPassword } from '../src/app.ts';

test('advisory API reads one validated simulation run and cannot create controls', async () => {
  const db = openDatabase();
  const app = buildApp({ db, operatorPasswordHash: hashPassword('test-password'),
    now: () => new Date('2026-11-06T15:00:00.000Z') });
  const output = generateScenario('insufficient-history', 7);
  registerDevice(db, 'sim-plant-01', 'simulator', 'Simulation', output.metadata.virtualStartAt);
  registerSimulationRun(db, { id: output.metadata.runId, seed: 7, scenario: output.metadata.scenario,
    scenarioVersion: '1', virtualStartAt: output.metadata.virtualStartAt, canonicalHash: 'fixture' });
  for (const packet of output.packets) ingestTelemetry(db, packet, { deviceId: 'sim-plant-01',
    source: 'simulator', runId: output.metadata.runId }, packet.sentAt);
  assert.equal((await app.inject({ method: 'GET', url: `/api/devices/sim-plant-01/analysis?runId=${output.metadata.runId}` })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'http://127.0.0.1:3000' },
    payload: { password: 'test-password' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const response = await app.inject({ method: 'GET', url: `/api/devices/sim-plant-01/analysis?runId=${output.metadata.runId}`,
    headers: { cookie } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'INSUFFICIENT_DATA');
  assert.equal(response.json().source, 'simulator');
  assert.equal(response.json().runId, output.metadata.runId);
  assert.equal(db.prepare('SELECT count(*) n FROM commands').get()?.n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM settings_desired').get()?.n, 0);
  await app.close(); db.close();
});
