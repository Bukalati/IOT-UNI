import { connect, type MqttClient } from 'mqtt';
import type { DatabaseSync } from 'node:sqlite';
import { validatePacket } from '@irrigation/contracts';
import { currentStatus, ingestTelemetry, markPublished, noteLivePacket, pendingCommands,
  recordAck, recordEvent, recordStatus, saveReportedSettings, hashPacket } from '@irrigation/data';

export type MessageNotice = { kind: string; deviceId: string; at: string; result: string };
export type Publisher = { connected: boolean; publish(topic: string, payload: string): Promise<void> };
export type BrokerOptions = { url: string; username: string; password: string; db: DatabaseSync;
  onNotice?: (notice: MessageNotice) => void; now?: () => Date };

export function consumePacket(db: DatabaseSync, topic: string, bytes: Buffer, retained: boolean,
  at: string): MessageNotice {
  const validation = validatePacket(topic, bytes, retained);
  if (!validation.ok) return { kind: 'diagnostic', deviceId: '', at, result: validation.code };
  const { packet, identity } = validation;
  const device = db.prepare('SELECT identity_kind FROM devices WHERE id=?').get(identity.deviceId) as
    { identity_kind: string } | undefined;
  if (!device || device.identity_kind !== (identity.source === 'device' ? 'physical' : 'simulator'))
    return { kind: 'diagnostic', deviceId: identity.deviceId, at, result: 'UNREGISTERED_IDENTITY' };
  if (identity.source === 'simulator' && !db.prepare('SELECT 1 FROM simulation_runs WHERE id=?').get(identity.runId))
    return { kind: 'diagnostic', deviceId: identity.deviceId, at, result: 'UNREGISTERED_RUN' };
  let result = 'stored';
  try {
    switch (identity.kind) {
      case 'telemetry':
        result = ingestTelemetry(db, packet, identity, at);
        break;
      case 'status': {
        const p = packet.payload as Record<string, unknown>;
        recordStatus(db, { deviceId: identity.deviceId, availability: p.availability as 'online' | 'offline',
          bootId: p.bootId as string | null, reason: p.reason as string, receivedAt: at, retained });
        break;
      }
      case 'events': {
        const p = packet.payload as Record<string, unknown>;
        result = recordEvent(db, { deviceId: identity.deviceId, bootId: packet.bootId as string,
          seq: packet.seq as number, eventId: p.eventId as string,
          eventType: p.eventType as 'PULSE_STARTED' | 'PULSE_ENDED' | 'STATE_CHANGED' | 'FAULT_RAISED' | 'FAULT_CLEARED',
          pulseId: p.pulseId as string | null, commandId: p.commandId as string | null,
          triggerSource: p.triggerSource as 'AUTO' | 'BUTTON' | 'WEB', actualMs: p.actualMs as number | null,
          reasonCode: p.reasonCode as string | null, receivedAt: at, payloadHash: hashPacket(packet) });
        if (result === 'inserted') noteLivePacket(db, identity.deviceId, packet.bootId as string, at);
        break;
      }
      case 'acks': {
        const p = packet.payload as Record<string, unknown>;
        result = recordAck(db, { deviceId: identity.deviceId, bootId: packet.bootId as string,
          seq: packet.seq as number, commandId: p.commandId as string,
          status: p.status as 'accepted' | 'rejected' | 'completed' | 'failed',
          reasonCode: p.reasonCode as string | null, pulseId: p.pulseId as string | null,
          receivedAt: at, payloadHash: hashPacket(packet) });
        if (result !== 'unmatched' && result !== 'conflict') noteLivePacket(db, identity.deviceId, packet.bootId as string, at);
        break;
      }
      case 'settings/reported': {
        const p = packet as Record<string, unknown>;
        result = saveReportedSettings(db, identity.deviceId, p.revision as number,
          p.values as Record<string, unknown>, p.calibrationRevision as number,
          p.rejectedRevision as number | null, p.reasonCode as string | null, at);
        break;
      }
      default:
        return { kind: 'diagnostic', deviceId: identity.deviceId, at, result: 'UNEXPECTED_BACKEND_INPUT' };
    }
  } catch {
    return { kind: 'diagnostic', deviceId: identity.deviceId, at, result: 'PERSISTENCE_ERROR' };
  }
  return { kind: identity.kind, deviceId: identity.deviceId, at, result };
}

export async function flushOutbox(db: DatabaseSync, publisher: Publisher, now: Date): Promise<number> {
  if (!publisher.connected) return 0;
  let count = 0;
  for (const command of pendingCommands(db, now.toISOString())) {
    const id = JSON.parse(command.packet).deviceId as string;
    if (currentStatus(db, id, now.toISOString()).availability !== 'online') continue;
    await publisher.publish(command.topic, command.packet);
    if (markPublished(db, command.id, now.toISOString())) count++;
  }
  return count;
}

export function connectBroker(options: BrokerOptions): { client: MqttClient; publisher: Publisher } {
  const now = options.now ?? (() => new Date());
  const client = connect(options.url, { username: options.username, password: options.password,
    protocolVersion: 4, clean: true, reconnectPeriod: 1000, clientId: `irrigation-backend-${process.pid}` });
  const publisher: Publisher = { get connected() { return client.connected; },
    publish(topic, payload) { return new Promise<void>((resolve, reject) => {
      client.publish(topic, payload, { qos: 1, retain: false }, error => error ? reject(error) : resolve());
    }); } };
  client.on('connect', () => {
    client.subscribe([
      'irrigation/v1/devices/+/telemetry', 'irrigation/v1/devices/+/status',
      'irrigation/v1/devices/+/events', 'irrigation/v1/devices/+/acks',
      'irrigation/v1/devices/+/settings/reported',
      'irrigation/v1/simulations/+/devices/+/telemetry', 'irrigation/v1/simulations/+/devices/+/status',
      'irrigation/v1/simulations/+/devices/+/events', 'irrigation/v1/simulations/+/devices/+/acks',
      'irrigation/v1/simulations/+/devices/+/settings/reported',
    ], { qos: 1 });
    void flushOutbox(options.db, publisher, now()).catch(() => undefined);
  });
  client.on('message', (topic, payload, packet) => {
    const notice = consumePacket(options.db, topic, payload, packet.retain, now().toISOString());
    options.onNotice?.(notice);
  });
  return { client, publisher };
}
