import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateScenario, scenarios } from '../../simulator/src/index.ts';
import { analyze, median, type Point } from '../src/index.ts';

function fixture(scenario: typeof scenarios[number], seed = 7) {
  const output = generateScenario(scenario, seed);
  const points: Point[] = output.packets.map((packet, index) => ({
    id: index + 1, deviceId: packet.deviceId, source: 'simulator', runId: output.metadata.runId,
    measuredAt: packet.sentAt, receivedAt: new Date(Date.parse(packet.sentAt) + 100).toISOString(),
    soilPercent: packet.payload.soilPercent, soilQuality: packet.payload.soilQuality,
    calibrationRevision: 1, bootId: packet.bootId, seq: packet.seq, timeTrusted: true,
  }));
  return { deviceId: 'sim-plant-01', source: 'simulator' as const, runId: output.metadata.runId, points };
}

test('gradual drying gives a versioned, reproducible advisory forecast', () => {
  const input = fixture('gradual-drying');
  const result = analyze(input);
  assert.equal(result.status, 'VALID');
  assert.ok(result.prediction.crossingAt);
  assert.ok(result.prediction.slopePpPerHour! < -0.25);
  assert.ok(result.prediction.rSquared! >= 0.6);
  assert.equal(result.inputHash, analyze(input).inputHash);
  assert.equal(result.source, 'simulator');
});

test('all eight scenarios classify without control side effects', () => {
  for (const scenario of scenarios) {
    const input = fixture(scenario);
    const result = analyze(input);
    assert.equal(result.source, 'simulator');
    assert.equal(result.runId, input.runId);
    assert.ok(['VALID', 'INSUFFICIENT_DATA', 'UNRELIABLE_TREND'].includes(result.status));
  }
  assert.equal(analyze(fixture('missing-samples')).status, 'INSUFFICIENT_DATA');
  assert.equal(analyze(fixture('insufficient-history')).reason, 'TOO_FEW_SAMPLES');
  assert.equal(analyze(fixture('stuck-sensor')).prediction.crossingAt, null);
  assert.ok(analyze(fixture('sudden-jump')).anomalies.some(flag => flag.type === 'UNEXPECTED_JUMP'));
});

test('watering boundary resets training segment', () => {
  const input = fixture('watering-increase');
  const end = input.points[361].measuredAt!;
  const result = analyze({ ...input, pulses: [{ id: 'pulse-1', endedAt: end, actualMs: 2000 }] });
  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.ok(Date.parse(result.trainingStart!) > Date.parse(end));
});

test('untrusted, mixed, flat and sparse histories abstain', () => {
  const input = fixture('gradual-drying');
  assert.equal(analyze({ ...input, points: input.points.map(p => ({ ...p, timeTrusted: false, measuredAt: null })) }).reason, 'TIME_UNTRUSTED');
  assert.equal(analyze({ ...input, points: [{ ...input.points[0], source: 'device' }, ...input.points.slice(1)] }).reason, 'MIXED_PROVENANCE');
  assert.equal(analyze({ ...input, points: input.points.map(p => ({ ...p, soilPercent: 40 })) }).prediction.crossingAt, null);
  assert.equal(analyze({ ...input, points: input.points.filter((_, i) => i % 4 === 0) }).reason, 'LOW_COVERAGE');
});

test('MAD and IQR zero cases stay finite; long constant segment flags candidate stuck reading', () => {
  assert.equal(median([1, 1, 1, 1]), 1);
  const input = fixture('stuck-sensor');
  const long = Array.from({ length: 4321 }, (_, index) => ({ ...input.points[0], id: index + 1,
    seq: index + 1, measuredAt: new Date(Date.parse(input.points[0].measuredAt!) + index * 5000).toISOString() }));
  const result = analyze({ ...input, points: long });
  assert.equal(result.status, 'UNRELIABLE_TREND');
  assert.ok(result.anomalies.some(flag => flag.type === 'STUCK_READING'));
  assert.ok(Number.isFinite(result.prediction.residualMadPp));
});
