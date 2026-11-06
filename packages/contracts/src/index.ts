import AjvPackage from 'ajv';

type JsonSchema = Record<string, unknown>;
export type PacketKind = 'telemetry' | 'status' | 'events' | 'commands' | 'acks' | 'settings/desired' | 'settings/reported';
type Identity = { deviceId: string; source: 'device' | 'simulator'; runId: string | null; kind: PacketKind };
export type Validation = { ok: true; packet: Record<string, unknown>; identity: Identity } | { ok: false; code: 'INVALID_SCHEMA' | 'UNAUTHORIZED_IDENTITY' | 'RETAINED_COMMAND'; detail: string };

const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const utc = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): JsonSchema => ({ type: 'integer', minimum: min, maximum: max });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const string = (pattern?: string): JsonSchema => ({ type: 'string', ...(pattern ? { pattern } : {}) });
const percent: JsonSchema = { type: 'number', minimum: 0, maximum: 100 };
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: 'object', additionalProperties: false, required, properties });
const oneOf = (values: string[]): JsonSchema => ({ type: 'string', enum: values });
const source = oneOf(['device', 'simulator']);
const qualitySoil = oneOf(['calibrated', 'uncalibrated', 'invalid', 'stale']);
const qualityTank = oneOf(['valid', 'uncalibrated', 'unknown', 'stale']);
const mode = oneOf(['AUTO', 'MANUAL', 'OFF']);
const state = oneOf(['IDLE', 'WATERING', 'SOAKING', 'LOCKOUT', 'FAULT']);
const reason = oneOf([
  'CLOCK_UNTRUSTED', 'COMMAND_EXPIRED', 'COMMAND_NOT_YET_VALID', 'BOOT_MISMATCH', 'RETAINED_COMMAND',
  'DUPLICATE_IN_PROGRESS', 'INVALID_SCHEMA', 'UNAUTHORIZED_IDENTITY', 'SOIL_UNCALIBRATED', 'SOIL_STALE',
  'SOIL_WET', 'TANK_UNKNOWN', 'TANK_LOW', 'BUDGET_EXHAUSTED', 'COMMISSIONING_REQUIRED', 'BUSY_OR_LOCKED',
  'LEDGER_WRITE_FAILED', 'INTERRUPTED', 'HARD_TIMEOUT', 'SENSOR_TRIP', 'SETTINGS_INVALID', 'SETTINGS_REVISION_OLD',
]);
const base = { schemaVersion: { const: 1 }, deviceId: string('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') };
const sequenced = {
  ...base, bootId: string(uuid), seq: integer(1, 4294967295), uptimeMs: integer(),
  sentAt: nullable(string(utc)), timeTrusted: { type: 'boolean' }, source,
};
const settingsValues = object({
  mode, dryThresholdPercent: percent, wetThresholdPercent: percent, manualWetCutoffPercent: percent,
  sampleIntervalMs: integer(1), maxSampleAgeMs: integer(1), defaultPulseMs: integer(1, 3000),
  maxPulseMs: integer(1, 3000), soakMs: integer(1), maxPulsesPerCycle: integer(1, 3),
  maxRolling24hRuntimeMs: integer(1, 20000), tankMinPercent: percent, consecutiveDrySamples: integer(1),
});

export const schemas: Record<PacketKind, JsonSchema> = {
  telemetry: object({ ...sequenced, payload: object({
    soilRaw: nullable(integer(0, 4095)), soilPercent: nullable(percent), soilQuality: qualitySoil,
    soilAcquiredUptimeMs: nullable(integer()), tankDistanceCm: nullable({ type: 'number', minimum: 0 }),
    tankPercent: nullable(percent), tankQuality: qualityTank, tankAcquiredUptimeMs: nullable(integer()),
    pumpOn: { type: 'boolean' }, mode, state, settingsRevision: integer(),
    soilCalibrationRevision: integer(), tankCalibrationRevision: integer(), wifiRssiDbm: nullable(integer(-120, 0)),
  }, ['soilRaw', 'soilPercent', 'soilQuality', 'soilAcquiredUptimeMs', 'tankDistanceCm', 'tankPercent',
      'tankQuality', 'tankAcquiredUptimeMs', 'pumpOn', 'mode', 'state', 'settingsRevision',
      'soilCalibrationRevision', 'tankCalibrationRevision']) }),
  status: object({ ...base, source, payload: object({
    availability: oneOf(['online', 'offline']), reason: oneOf(['CONNECTED', 'LWT', 'ORDERLY_DISCONNECT']),
    firmwareVersion: nullable(string()), bootId: nullable(string(uuid)), publishedAt: nullable(string(utc)),
  }) }),
  events: object({ ...sequenced, payload: object({
    eventId: string(uuid), eventType: oneOf(['PULSE_STARTED', 'PULSE_ENDED', 'STATE_CHANGED', 'FAULT_RAISED', 'FAULT_CLEARED']),
    pulseId: nullable(string(uuid)), commandId: nullable(string(uuid)), triggerSource: oneOf(['AUTO', 'BUTTON', 'WEB']),
    stateFrom: state, stateTo: state, actualMs: nullable(integer()), reasonCode: nullable(reason),
  }) }),
  commands: object({ ...base, commandId: string(uuid), targetBootId: string(uuid),
    createdAt: string(utc), expiresAt: string(utc), type: { const: 'WATER_PULSE' },
    payload: object({ durationMs: integer(1, 3000) }),
  }),
  acks: object({ ...sequenced, payload: object({
    commandId: string(uuid), status: oneOf(['accepted', 'rejected', 'completed', 'failed']),
    reasonCode: nullable(reason), pulseId: nullable(string(uuid)),
  }) }),
  'settings/desired': object({ ...base, revision: integer(1), values: settingsValues, issuedAt: string(utc) }),
  'settings/reported': object({ ...base, source, revision: integer(0), values: settingsValues,
    calibrationRevision: integer(), rejectedRevision: nullable(integer(1)), reasonCode: nullable(reason),
  }),
};

const Ajv = AjvPackage as unknown as typeof import('ajv').Ajv;
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, ajv.compile(schema)]));

function topicIdentity(topic: string): Identity | null {
  const parts = topic.split('/');
  if (parts[0] !== 'irrigation' || parts[1] !== 'v1') return null;
  let sourceValue: 'device' | 'simulator';
  let runId: string | null = null;
  let deviceIndex: number;
  if (parts[2] === 'devices') { sourceValue = 'device'; deviceIndex = 3; }
  else if (parts[2] === 'simulations' && parts[4] === 'devices') { sourceValue = 'simulator'; runId = parts[3]; deviceIndex = 5; }
  else return null;
  const deviceId = parts[deviceIndex];
  const kind = parts.slice(deviceIndex + 1).join('/') as PacketKind;
  if (!deviceId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deviceId) ||
      (runId !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) || !schemas[kind]) return null;
  return { deviceId, source: sourceValue, runId, kind };
}

function depth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  return 1 + Math.max(0, ...Object.values(value).map(depth));
}

export function validatePacket(topic: string, bytes: Buffer, retained = false): Validation {
  const identity = topicIdentity(topic);
  if (!identity) return { ok: false, code: 'UNAUTHORIZED_IDENTITY', detail: 'Invalid topic' };
  if (bytes.length > 2048) return { ok: false, code: 'INVALID_SCHEMA', detail: 'Payload exceeds 2048 bytes' };
  let packet: Record<string, unknown>;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    packet = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'INVALID_SCHEMA', detail: 'Invalid UTF-8 or JSON' };
  }
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || depth(packet) > 4)
    return { ok: false, code: 'INVALID_SCHEMA', detail: 'Invalid object depth' };
  const validate = validators[identity.kind];
  if (!validate(packet)) return { ok: false, code: 'INVALID_SCHEMA', detail: ajv.errorsText(validate.errors) };
  if (packet.deviceId !== identity.deviceId || ('source' in packet && packet.source !== identity.source))
    return { ok: false, code: 'UNAUTHORIZED_IDENTITY', detail: 'Topic and packet identity differ' };
  if (identity.source === 'simulator' && !identity.deviceId.startsWith('sim-'))
    return { ok: false, code: 'UNAUTHORIZED_IDENTITY', detail: 'Simulator device ID must be distinct' };
  if (identity.kind === 'commands') {
    if (retained) return { ok: false, code: 'RETAINED_COMMAND', detail: 'Actuation command must not be retained' };
    const created = Date.parse(packet.createdAt as string);
    const expires = Date.parse(packet.expiresAt as string);
    if (!Number.isFinite(created) || expires - created !== 10000)
      return { ok: false, code: 'INVALID_SCHEMA', detail: 'Invalid command lifetime' };
  }
  for (const field of ['sentAt', 'createdAt', 'expiresAt', 'issuedAt']) {
    if (typeof packet[field] === 'string' && !Number.isFinite(Date.parse(packet[field] as string)))
      return { ok: false, code: 'INVALID_SCHEMA', detail: `Invalid ${field}` };
  }
  if (identity.kind === 'status') {
    const publishedAt = (packet.payload as Record<string, unknown>).publishedAt;
    if (typeof publishedAt === 'string' && !Number.isFinite(Date.parse(publishedAt)))
      return { ok: false, code: 'INVALID_SCHEMA', detail: 'Invalid publishedAt' };
  }
  if ('timeTrusted' in packet && (packet.timeTrusted !== (packet.sentAt !== null)))
    return { ok: false, code: 'INVALID_SCHEMA', detail: 'Time trust mismatch' };
  if (identity.kind === 'telemetry') {
    const payload = packet.payload as Record<string, unknown>;
    if ((payload.soilQuality === 'calibrated') !== (payload.soilPercent !== null) ||
        (payload.tankQuality === 'valid') !== (payload.tankPercent !== null))
      return { ok: false, code: 'INVALID_SCHEMA', detail: 'Quality and percent mismatch' };
    for (const field of ['soilAcquiredUptimeMs', 'tankAcquiredUptimeMs'])
      if (payload[field] !== null && (payload[field] as number) > (packet.uptimeMs as number))
        return { ok: false, code: 'INVALID_SCHEMA', detail: 'Acquisition after publication' };
    for (const [qualityField, acquisitionField, validQuality] of [
      ['soilQuality', 'soilAcquiredUptimeMs', 'calibrated'],
      ['tankQuality', 'tankAcquiredUptimeMs', 'valid'],
    ]) {
      const acquired = payload[acquisitionField];
      if (payload[qualityField] === validQuality &&
          (acquired === null || (packet.uptimeMs as number) - (acquired as number) >= 15000))
        return { ok: false, code: 'INVALID_SCHEMA', detail: 'Valid quality requires fresh acquisition' };
    }
  }
  if (identity.kind === 'acks') {
    const payload = packet.payload as Record<string, unknown>;
    if (payload.status === 'completed' && payload.pulseId === null)
      return { ok: false, code: 'INVALID_SCHEMA', detail: 'Completed ACK requires pulse ID' };
  }
  if (identity.kind === 'events') {
    const payload = packet.payload as Record<string, unknown>;
    if (payload.eventType === 'PULSE_ENDED' && (payload.pulseId === null || payload.actualMs === null))
      return { ok: false, code: 'INVALID_SCHEMA', detail: 'Pulse end requires ID and duration' };
  }
  if (identity.kind.startsWith('settings/')) {
    const values = packet.values as Record<string, number>;
    if (values.dryThresholdPercent >= values.wetThresholdPercent ||
        values.defaultPulseMs > values.maxPulseMs || values.manualWetCutoffPercent < values.wetThresholdPercent)
      return { ok: false, code: 'INVALID_SCHEMA', detail: 'Inconsistent safety settings' };
    const fixedV1: Record<string, number> = {
      dryThresholdPercent: 30, wetThresholdPercent: 45, manualWetCutoffPercent: 45,
      sampleIntervalMs: 5000, maxSampleAgeMs: 15000, defaultPulseMs: 2000,
      maxPulseMs: 3000, soakMs: 60000, maxPulsesPerCycle: 3,
      maxRolling24hRuntimeMs: 20000, consecutiveDrySamples: 3,
    };
    if (Object.entries(fixedV1).some(([key, expected]) => values[key] !== expected))
      return { ok: false, code: 'INVALID_SCHEMA', detail: 'Unsupported v1 safety value' };
  }
  return { ok: true, packet, identity };
}
