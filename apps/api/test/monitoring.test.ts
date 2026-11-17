import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '@irrigation/data';
import { buildApp, hashPassword } from '../src/app.ts';

test('alerts and latest calibration are authenticated and scoped to one device', async () => {
  const db = openDatabase();
  const origin = 'http://127.0.0.1:3000';
  const app = buildApp({ db, origin, now: () => new Date('2026-11-17T12:00:00.000Z'),
    operatorPasswordHash: hashPassword('local-test-password') });
  db.prepare(`INSERT INTO alerts(device_id,code,severity,opened_at,details_json)
    VALUES('plant-01','SEQ_CONFLICT','critical','2026-11-17T11:00:00.000Z','{"seq":4}')`).run();
  db.prepare(`INSERT INTO calibrations(device_id,kind,revision,endpoint_a,endpoint_b,status,reported_at)
    VALUES('plant-01','soil',1,NULL,NULL,'uncalibrated','2026-11-17T11:00:00.000Z')`).run();

  assert.equal((await app.inject({ url: '/api/devices/plant-01/alerts' })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin },
    payload: { password: 'local-test-password' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const headers = { cookie };

  const alerts = await app.inject({ url: '/api/devices/plant-01/alerts', headers });
  assert.equal(alerts.statusCode, 200);
  assert.equal(alerts.json().alerts[0].code, 'SEQ_CONFLICT');
  assert.deepEqual(alerts.json().alerts[0].details, { seq: 4 });
  assert.equal((await app.inject({ url: '/api/devices/missing/alerts', headers })).statusCode, 404);

  const calibrations = await app.inject({ url: '/api/devices/plant-01/calibrations', headers });
  assert.equal(calibrations.statusCode, 200);
  assert.equal(calibrations.json().calibrations[0].status, 'uncalibrated');
  await app.close();
  db.close();
});
