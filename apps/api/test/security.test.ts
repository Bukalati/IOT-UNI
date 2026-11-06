import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '@irrigation/data';
import { buildApp, hashPassword } from '../src/app.ts';

const origin = 'http://127.0.0.1:3000';
const clock = () => new Date('2026-11-06T15:00:00.000Z');
const bootId = '00000000-0000-4000-8000-000000000001';

test('command route requires session, origin and CSRF; stale device is denied', async () => {
  const db = openDatabase();
  const app = buildApp({ db, now: clock, operatorPasswordHash: hashPassword('local-test-password'), origin,
    hardwareCommissioned: true });
  const path = '/api/devices/plant-01/commands';
  const body = { durationMs: 2000 };
  assert.equal((await app.inject({ method: 'POST', url: path, payload: body })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'local-test-password' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { password: 'bad' } })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { password: 'local-test-password' } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const csrf = login.json().csrfToken as string;
  assert.equal((await app.inject({ method: 'POST', url: path, headers: { cookie, origin }, payload: body })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: path, headers: { cookie, origin: 'http://evil.test', 'x-csrf-token': csrf }, payload: body })).statusCode, 403);
  const stale = await app.inject({ method: 'POST', url: path,
    headers: { cookie, origin, 'x-csrf-token': csrf }, payload: body });
  assert.equal(stale.statusCode, 409);
  assert.equal(db.prepare('SELECT count(*) n FROM commands').get()?.n, 0);
  await app.close(); db.close();
});

test('fresh boot only queues one bounded command; acceptance is not completion', async () => {
  const db = openDatabase();
  const app = buildApp({ db, now: clock, operatorPasswordHash: hashPassword('local-test-password'), origin,
    hardwareCommissioned: true });
  db.prepare('INSERT INTO device_boots(device_id,boot_id,first_seen_at) VALUES(?,?,?)').run('plant-01', bootId, clock().toISOString());
  db.prepare(`INSERT INTO device_status(device_id,availability,boot_id,reason,received_at,last_live_at,retained)
    VALUES('plant-01','online',?,'CONNECTED',?,?,0)`).run(bootId, clock().toISOString(), clock().toISOString());
  const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { password: 'local-test-password' } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin,
    'x-csrf-token': login.json().csrfToken as string };
  const invalid = await app.inject({ method: 'POST', url: '/api/devices/plant-01/commands', headers, payload: { durationMs: 4000 } });
  assert.equal(invalid.statusCode, 400);
  const queued = await app.inject({ method: 'POST', url: '/api/devices/plant-01/commands', headers, payload: { durationMs: 2000 } });
  assert.equal(queued.statusCode, 202);
  assert.equal(queued.json().status, 'queued');
  assert.equal(db.prepare('SELECT status FROM commands').get()?.status, 'queued');
  assert.equal(db.prepare('SELECT count(*) n FROM command_outbox').get()?.n, 1);
  await app.close(); db.close();
});

test('production default blocks physical command even with a fresh boot', async () => {
  const db = openDatabase();
  const app = buildApp({ db, now: clock, operatorPasswordHash: hashPassword('local-test-password'), origin });
  db.prepare('INSERT INTO device_boots(device_id,boot_id,first_seen_at) VALUES(?,?,?)').run('plant-01', bootId, clock().toISOString());
  db.prepare(`INSERT INTO device_status(device_id,availability,boot_id,reason,received_at,last_live_at,retained)
    VALUES('plant-01','online',?,'CONNECTED',?,?,0)`).run(bootId, clock().toISOString(), clock().toISOString());
  const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { password: 'local-test-password' } });
  const response = await app.inject({ method: 'POST', url: '/api/devices/plant-01/commands',
    headers: { cookie: String(login.headers['set-cookie']).split(';')[0], origin,
      'x-csrf-token': login.json().csrfToken as string }, payload: { durationMs: 2000 } });
  assert.equal(response.statusCode, 423);
  assert.equal(response.json().code, 'HARDWARE_NOT_COMMISSIONED');
  assert.equal(db.prepare('SELECT count(*) n FROM commands').get()?.n, 0);
  await app.close(); db.close();
});
