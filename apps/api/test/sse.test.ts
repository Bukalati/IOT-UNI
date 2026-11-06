import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '@irrigation/data';
import { buildApp, hashPassword } from '../src/app.ts';

test('SSE sends a snapshot and a monotonic cursor on reconnect', async () => {
  const db = openDatabase();
  const app = buildApp({ db, operatorPasswordHash: hashPassword('test-password') });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await fetch(`${address}/auth/login`, { method: 'POST', headers: {
    Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const firstAbort = new AbortController();
  try {
    const first = await fetch(`${address}/api/events`, { headers: { Cookie: cookie }, signal: firstAbort.signal });
    assert.equal(first.status, 200);
    const reader = first.body!.getReader();
    const snapshot = new TextDecoder().decode((await reader.read()).value);
    assert.match(snapshot, /event: snapshot/);
    assert.match(snapshot, /id: 0/);
    app.notice({ kind: 'telemetry', deviceId: 'plant-01', at: new Date().toISOString(), result: 'inserted' });
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.match(update, /event: update/);
    assert.match(update, /id: 1/);
    firstAbort.abort();
    const secondAbort = new AbortController();
    try {
      const second = await fetch(`${address}/api/events`, { headers: { Cookie: cookie, 'Last-Event-ID': '1' }, signal: secondAbort.signal });
      const nextSnapshot = new TextDecoder().decode((await second.body!.getReader().read()).value);
      assert.match(nextSnapshot, /event: snapshot/);
      assert.match(nextSnapshot, /id: 1/);
    } finally { secondAbort.abort(); }
  } finally {
    firstAbort.abort();
    await app.close(); db.close();
  }
});
