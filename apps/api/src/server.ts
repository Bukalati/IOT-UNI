import { mkdirSync } from 'node:fs';
import { openDatabase } from '@irrigation/data';
import { buildApp } from './app.js';
import { connectBroker, flushOutbox } from './mqtt-service.js';

mkdirSync('data', { recursive: true });
const db = openDatabase(process.env.SQLITE_PATH ?? 'data/app.sqlite');
const app = buildApp({ db, operatorPasswordHash: process.env.OPERATOR_PASSWORD_HASH,
  origin: process.env.APP_ORIGIN ?? 'http://127.0.0.1:3000' });
let broker: ReturnType<typeof connectBroker> | undefined;
if (process.env.MQTT_PASSWORD) {
  broker = connectBroker({ url: process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883',
    username: process.env.MQTT_USER ?? 'backend', password: process.env.MQTT_PASSWORD,
    db, onNotice: app.notice });
  setInterval(() => { if (broker) void flushOutbox(db, broker.publisher, new Date()).catch(() => undefined); }, 1000).unref();
}
const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '127.0.0.1';
try { await app.listen({ port, host }); }
catch (error) { app.log.error(error); process.exitCode = 1; }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  broker?.client.end(true);
  void app.close().finally(() => db.close());
});
