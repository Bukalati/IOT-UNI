import { createHash } from 'node:crypto';

export const scenarios = [
  'gradual-drying', 'watering-increase', 'sensor-noise', 'stuck-sensor',
  'sudden-jump', 'missing-samples', 'empty-reservoir', 'insufficient-history',
] as const;
export type Scenario = typeof scenarios[number];
export const scenarioVersion = '1';
const startAt = '2026-11-06T08:00:00.000Z';
const intervalMs = 5000;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

function bootId(seed: number, scenario: Scenario): string {
  const hex = createHash('sha256').update(`${seed}:${scenario}:${scenarioVersion}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type SimPacket = {
  schemaVersion: 1; deviceId: string; bootId: string; seq: number; uptimeMs: number;
  sentAt: string; timeTrusted: true; source: 'simulator'; payload: {
    soilRaw: number; soilPercent: number; soilQuality: 'calibrated'; soilAcquiredUptimeMs: number;
    tankDistanceCm: number; tankPercent: number; tankQuality: 'valid'; tankAcquiredUptimeMs: number;
    pumpOn: boolean; mode: 'AUTO'; state: 'IDLE' | 'WATERING' | 'SOAKING' | 'LOCKOUT';
    settingsRevision: 1; soilCalibrationRevision: 1; tankCalibrationRevision: 1; wifiRssiDbm: number;
  };
};
export type ScenarioOutput = {
  metadata: { runId: string; seed: number; scenario: Scenario; scenarioVersion: string; virtualStartAt: string; intervalMs: number; source: 'simulator' };
  packets: SimPacket[];
  markers: { at: string; type: 'SIMULATED_PULSE' | 'NO_WATER_LOW_TANK'; note: string }[];
};

export function generateScenario(scenario: Scenario, seed: number): ScenarioOutput {
  if (!scenarios.includes(scenario) || !Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295)
    throw new Error('Invalid scenario or seed');
  const rng = random(seed || 1);
  const runId = `run-${scenario}-${seed}`;
  const deviceId = 'sim-plant-01';
  const id = bootId(seed, scenario);
  const count = scenario === 'insufficient-history' ? 8 : 900;
  const packets: SimPacket[] = [];
  const markers: ScenarioOutput['markers'] = [];
  for (let slot = 0; slot < count; slot++) {
    if (scenario === 'missing-samples' && (slot % 4 !== 0 || (slot >= 360 && slot < 600))) continue;
    const uptimeMs = slot * intervalMs;
    const sentAt = new Date(Date.parse(startAt) + uptimeMs).toISOString();
    let soil = 44 - slot * 0.012 + (rng() - 0.5) * 0.5;
    if (scenario === 'watering-increase' && slot >= 360) soil += 8;
    if (scenario === 'sensor-noise') soil += (rng() - 0.5) * 7;
    if (scenario === 'stuck-sensor') soil = 42;
    if (scenario === 'sudden-jump' && slot >= 480) soil += 12;
    if (scenario === 'insufficient-history') soil = 40 - slot * 0.01;
    soil = Math.round(Math.max(0, Math.min(100, soil)) * 100) / 100;
    const tankPercent = scenario === 'empty-reservoir' ? 0 : 70;
    const pumpOn = scenario === 'watering-increase' && slot >= 360 && slot < 361;
    const state: SimPacket['payload']['state'] = scenario === 'empty-reservoir' ? 'LOCKOUT'
      : pumpOn ? 'WATERING' : scenario === 'watering-increase' && slot >= 361 && slot < 373 ? 'SOAKING' : 'IDLE';
    packets.push({ schemaVersion: 1, deviceId, bootId: id, seq: packets.length + 1,
      uptimeMs, sentAt, timeTrusted: true, source: 'simulator', payload: {
        soilRaw: Math.round(4095 - soil * 20), soilPercent: soil, soilQuality: 'calibrated',
        soilAcquiredUptimeMs: uptimeMs, tankDistanceCm: tankPercent === 0 ? 25 : 10,
        tankPercent, tankQuality: 'valid', tankAcquiredUptimeMs: uptimeMs,
        pumpOn, mode: 'AUTO', state, settingsRevision: 1,
        soilCalibrationRevision: 1, tankCalibrationRevision: 1, wifiRssiDbm: -55,
      } });
  }
  if (scenario === 'watering-increase') markers.push({ at: new Date(Date.parse(startAt) + 360 * intervalMs).toISOString(),
    type: 'SIMULATED_PULSE', note: 'Virtual pulse marker; no physical pump or flow evidence' });
  if (scenario === 'empty-reservoir') markers.push({ at: startAt, type: 'NO_WATER_LOW_TANK',
    note: 'Virtual low tank lockout; no pulse' });
  return { metadata: { runId, seed, scenario, scenarioVersion, virtualStartAt: startAt, intervalMs, source: 'simulator' }, packets, markers };
}

export function canonicalOutput(output: ScenarioOutput): string {
  return JSON.stringify(output);
}
export function outputHash(output: ScenarioOutput): string {
  return createHash('sha256').update(canonicalOutput(output)).digest('hex');
}
