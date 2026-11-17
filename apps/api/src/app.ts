import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { currentStatus, migrate, openDatabase, queueCommand, registerDevice } from '@irrigation/data';
import { validatePacket } from '@irrigation/contracts';
import { analyze, type Point } from '@irrigation/intelligence';
import { createSession, hashPassword, requireSession, sessionCookie, sessionForRequest, verifyPassword } from './auth.js';
import { flushOutbox, type MessageNotice, type Publisher } from './mqtt-service.js';

export { hashPassword };
export type AppOptions = {
  db?: DatabaseSync; now?: () => Date; operatorPasswordHash?: string; origin?: string;
  publisher?: Publisher; physicalDeviceId?: string; hardwareCommissioned?: boolean;
};

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 2048 });
  const db = options.db ?? openDatabase();
  migrate(db);
  const now = options.now ?? (() => new Date());
  const origin = options.origin ?? 'http://127.0.0.1:3000';
  const physicalDeviceId = options.physicalDeviceId ?? 'plant-01';
  if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(physicalDeviceId))
    registerDevice(db, physicalDeviceId, 'physical', 'گیاه اصلی', now().toISOString());
  const events = new EventEmitter();
  let cursor = 0;

  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin === origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
  app.get('/health', async () => ({ status: 'ok', service: 'api', phase: 'P03' }));
  app.post('/auth/login', { schema: { body: { type: 'object', additionalProperties: false,
    required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 256 } } } } },
  async (request, reply) => {
    if (request.headers.origin !== origin) return reply.code(403).send({ code: 'ORIGIN_DENIED' });
    if (!options.operatorPasswordHash || !verifyPassword((request.body as { password: string }).password, options.operatorPasswordHash))
      return reply.code(401).send({ code: 'INVALID_CREDENTIALS' });
    const session = createSession(db, now());
    reply.header('Set-Cookie', sessionCookie(session.token, origin.startsWith('https://')));
    return { csrfToken: session.csrfToken };
  });
  app.post('/auth/logout', async (request, reply) => {
    const session = requireSession(db, request, reply, now(), origin, true);
    if (!session) return reply;
    db.prepare('DELETE FROM operator_sessions WHERE token_hash=?').run(session.tokenHash);
    reply.header('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });
  app.get('/auth/session', async (request, reply) => {
    const session = requireSession(db, request, reply, now(), origin);
    if (!session) return reply;
    return { csrfToken: session.csrfToken };
  });
  app.get('/api/devices', async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin)) return reply;
    const devices = db.prepare('SELECT id,identity_kind,display_name FROM devices ORDER BY identity_kind,id').all();
    return { devices: devices.map(device => ({ ...device,
      status: currentStatus(db, device.id as string, now().toISOString()) })) };
  });
  app.get('/api/simulations', async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin)) return reply;
    return { runs: db.prepare('SELECT id,scenario,seed,scenario_version,canonical_hash FROM simulation_runs ORDER BY scenario,id').all() };
  });
  app.get('/api/devices/:id', { schema: { params: { type: 'object', additionalProperties: false,
    required: ['id'], properties: { id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' } } },
    querystring: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string' } } } } },
  async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin)) return reply;
    const id = (request.params as { id: string }).id;
    const device = db.prepare('SELECT id,identity_kind,display_name FROM devices WHERE id=?').get(id);
    if (!device) return reply.code(404).send({ code: 'DEVICE_NOT_FOUND' });
    const runId = (request.query as { runId?: string }).runId;
    if (runId && (device.identity_kind !== 'simulator' || !db.prepare('SELECT 1 FROM simulation_runs WHERE id=?').get(runId)))
      return reply.code(400).send({ code: 'INVALID_RUN' });
    const latest = db.prepare(`SELECT received_at,measured_at,soil_percent,soil_quality,tank_percent,tank_quality,
      pump_on,mode,state,source,simulation_run_id FROM telemetry WHERE device_id=?
      AND (? IS NULL OR simulation_run_id=?) ORDER BY received_at DESC,id DESC LIMIT 1`).get(id, runId ?? null, runId ?? null);
    const desired = db.prepare('SELECT revision,values_json,status,issued_at FROM settings_desired WHERE device_id=? ORDER BY revision DESC LIMIT 1').get(id);
    const reported = db.prepare('SELECT revision,values_json,received_at FROM settings_reported WHERE device_id=? ORDER BY revision DESC,received_at DESC LIMIT 1').get(id);
    return { device, status: currentStatus(db, id, now().toISOString()), latest, desired, reported,
      hardwareCommissioned: options.hardwareCommissioned === true };
  });
  app.get('/api/devices/:id/history', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, runId: { type: 'string' } } },
  } }, async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin)) return reply;
    const id = (request.params as { id: string }).id;
    const query = request.query as { limit?: number; runId?: string };
    const limit = query.limit ?? 200;
    const device = db.prepare('SELECT identity_kind FROM devices WHERE id=?').get(id) as { identity_kind: string } | undefined;
    if (!device) return reply.code(404).send({ code: 'DEVICE_NOT_FOUND' });
    let runId = query.runId ?? null;
    if (device.identity_kind === 'simulator' && !runId) {
      const latest = db.prepare('SELECT simulation_run_id FROM telemetry WHERE device_id=? ORDER BY received_at DESC,id DESC LIMIT 1').get(id);
      runId = latest?.simulation_run_id as string | null ?? null;
    }
    if ((device.identity_kind === 'physical' && runId) ||
        (device.identity_kind === 'simulator' && (!runId || !db.prepare('SELECT 1 FROM simulation_runs WHERE id=?').get(runId))))
      return reply.code(400).send({ code: 'INVALID_RUN' });
    const rows = db.prepare(`SELECT measured_at,received_at,soil_percent,soil_quality,tank_percent,tank_quality,
      source,simulation_run_id,seq FROM telemetry WHERE device_id=? AND (? IS NULL OR simulation_run_id=?)
      ORDER BY received_at DESC,id DESC LIMIT ?`).all(id, runId, runId, limit);
    return { rows: rows.reverse() };
  });
  app.get('/api/devices/:id/alerts', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' } } },
    querystring: { type: 'object', additionalProperties: false, properties: {
      includeResolved: { type: 'string', enum: ['true', 'false'] }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    } },
  } }, async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin)) return reply;
    const id = (request.params as { id: string }).id;
    if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(id)) return reply.code(404).send({ code: 'DEVICE_NOT_FOUND' });
    const query = request.query as { includeResolved?: string; limit?: number };
    const rows = db.prepare(`SELECT id,code,severity,opened_at,resolved_at,details_json FROM alerts
      WHERE device_id=? AND (?=1 OR resolved_at IS NULL) ORDER BY opened_at DESC,id DESC LIMIT ?`)
      .all(id, query.includeResolved === 'true' ? 1 : 0, query.limit ?? 50);
    return { alerts: rows.map(row => ({ ...row, details: JSON.parse(row.details_json as string) })) };
  });
  app.get('/api/devices/:id/calibrations', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' } } },
  } }, async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin)) return reply;
    const id = (request.params as { id: string }).id;
    if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(id)) return reply.code(404).send({ code: 'DEVICE_NOT_FOUND' });
    const rows = db.prepare(`SELECT kind,revision,endpoint_a,endpoint_b,status,reported_at FROM calibrations
      WHERE device_id=? ORDER BY kind,revision DESC`).all(id);
    const latest = new Map<string, unknown>();
    for (const row of rows) if (!latest.has(row.kind as string)) latest.set(row.kind as string, row);
    return { calibrations: [...latest.values()] };
  });
  app.get('/api/devices/:id/analysis', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    querystring: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string' } } },
  } }, async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin)) return reply;
    const id = (request.params as { id: string }).id;
    const runId = (request.query as { runId?: string }).runId ?? null;
    const device = db.prepare('SELECT identity_kind FROM devices WHERE id=?').get(id) as { identity_kind: string } | undefined;
    if (!device) return reply.code(404).send({ code: 'DEVICE_NOT_FOUND' });
    const source = device.identity_kind === 'physical' ? 'device' : 'simulator';
    if ((source === 'device' && runId) || (source === 'simulator' && (!runId || !db.prepare('SELECT 1 FROM simulation_runs WHERE id=?').get(runId))))
      return reply.code(400).send({ code: 'INVALID_RUN' });
    const rows = db.prepare(`SELECT id,boot_id,seq,measured_at,received_at,soil_percent,soil_quality,
      soil_calibration_revision,time_trusted,pump_on FROM telemetry WHERE device_id=? AND
      (? IS NULL OR simulation_run_id=?) ORDER BY measured_at DESC,id DESC LIMIT 20000`).all(id, runId, runId).reverse();
    const points: Point[] = rows.map(row => ({ id: row.id as number, deviceId: id, source, runId,
      measuredAt: row.measured_at as string | null, receivedAt: row.received_at as string,
      soilPercent: row.soil_percent as number | null, soilQuality: row.soil_quality as string,
      calibrationRevision: row.soil_calibration_revision as number, bootId: row.boot_id as string,
      seq: row.seq as number, timeTrusted: row.time_trusted === 1 }));
    const latest = points.filter(point => point.measuredAt).at(-1)?.measuredAt;
    return analyze({ deviceId: id, source, runId, points,
      discontinuities: rows.filter(row => row.pump_on === 1 && row.measured_at).map(row => row.measured_at as string),
      asOf: source === 'simulator' ? latest ?? now().toISOString() : now().toISOString() });
  });
  app.post('/api/devices/:id/commands', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    body: { type: 'object', additionalProperties: false, required: ['durationMs'],
      properties: { durationMs: { type: 'integer', minimum: 1, maximum: 3000 } } },
  } }, async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin, true)) return reply;
    const id = (request.params as { id: string }).id;
    const device = db.prepare('SELECT identity_kind FROM devices WHERE id=?').get(id) as { identity_kind: string } | undefined;
    if (!device || device.identity_kind !== 'physical') return reply.code(404).send({ code: 'DEVICE_NOT_FOUND' });
    if (!options.hardwareCommissioned) return reply.code(423).send({ code: 'HARDWARE_NOT_COMMISSIONED' });
    const status = currentStatus(db, id, now().toISOString());
    if (status.availability !== 'online' || !status.bootId ||
        !db.prepare('SELECT 1 FROM device_boots WHERE device_id=? AND boot_id=?').get(id, status.bootId))
      return reply.code(409).send({ code: 'DEVICE_NOT_FRESH' });
    const createdAt = now().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 10000).toISOString();
    const durationMs = (request.body as { durationMs: number }).durationMs;
    const commandId = randomUUID();
    const packet = { schemaVersion: 1, commandId, deviceId: id, targetBootId: status.bootId,
      createdAt, expiresAt, type: 'WATER_PULSE', payload: { durationMs } };
    const topic = `irrigation/v1/devices/${id}/commands`;
    const validated = validatePacket(topic, Buffer.from(JSON.stringify(packet)));
    if (!validated.ok) return reply.code(400).send({ code: validated.code });
    queueCommand(db, { id: commandId, deviceId: id, targetBootId: status.bootId,
      createdAt, expiresAt, durationMs, source: 'device', topic, packet });
    emit({ kind: 'command', deviceId: id, at: createdAt, result: 'queued' });
    if (options.publisher) void flushOutbox(db, options.publisher, now()).catch(() => undefined);
    return reply.code(202).send({ commandId, status: 'queued', expiresAt });
  });
  app.get('/api/commands/:id', { schema: { params: { type: 'object', additionalProperties: false,
    required: ['id'], properties: { id: { type: 'string' } } } } }, async (request, reply) => {
    if (!requireSession(db, request, reply, now(), origin)) return reply;
    const command = db.prepare('SELECT id,device_id,status,reason_code,created_at,expires_at FROM commands WHERE id=?')
      .get((request.params as { id: string }).id);
    return command ?? reply.code(404).send({ code: 'COMMAND_NOT_FOUND' });
  });
  app.get('/api/events', (request, reply) => {
    if (!sessionForRequest(db, request, now())) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' });
    const send = (notice: MessageNotice) => reply.raw.write(`id: ${++cursor}\nevent: update\ndata: ${JSON.stringify(notice)}\n\n`);
    reply.raw.write(`id: ${cursor}\nevent: snapshot\ndata: ${JSON.stringify({ deviceId: physicalDeviceId,
      status: currentStatus(db, physicalDeviceId, now().toISOString()) })}\n\n`);
    events.on('notice', send);
    const keepalive = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    request.raw.on('close', () => { clearInterval(keepalive); events.off('notice', send); });
  });
  function emit(notice: MessageNotice) { events.emit('notice', notice); }
  app.addHook('onClose', async () => { events.removeAllListeners(); if (!options.db) db.close(); });
  return Object.assign(app, { notice: emit, database: db });
}
