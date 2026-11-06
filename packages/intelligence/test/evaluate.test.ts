import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from '../src/evaluate.ts';
import type { Point } from '../src/index.ts';

function longFixture(): Point[] {
  const start = Date.parse('2026-11-06T00:00:00.000Z');
  return Array.from({ length: 8641 }, (_, index) => {
    const hour = index * 5000 / 3600000;
    return { id: index + 1, deviceId: 'sim-eval-01', source: 'simulator', runId: 'eval-seed-7',
      measuredAt: new Date(start + index * 5000).toISOString(),
      receivedAt: new Date(start + index * 5000 + 100).toISOString(),
      soilPercent: Math.round((48 - 1.5 * hour) * 100) / 100, soilQuality: 'calibrated',
      calibrationRevision: 1, bootId: 'boot-eval', seq: index + 1, timeTrusted: true };
  });
}

test('chronological evaluation reports actual counts and separate simulated provenance', () => {
  const points = longFixture();
  const report = evaluate({ deviceId: 'sim-eval-01', source: 'simulator', runId: 'eval-seed-7', points });
  assert.equal(report.status, 'VALID');
  assert.equal(report.source, 'simulator');
  assert.ok(report.eligibleOrigins >= 2);
  assert.ok(report.candidateValid > 0);
  assert.ok(report.horizons['1h'].candidateCount > 0);
  assert.ok(report.crossing.observedCases > 0);
  assert.ok(report.horizons['1h'].candidateMae !== null);
  assert.equal(report.inputHash, evaluate({ deviceId: 'sim-eval-01', source: 'simulator', runId: 'eval-seed-7', points }).inputHash);
});

test('short history yields an explicit insufficient evaluation report', () => {
  const report = evaluate({ deviceId: 'sim-eval-01', source: 'simulator', runId: 'eval-seed-7', points: longFixture().slice(0, 500) });
  assert.equal(report.status, 'INSUFFICIENT_EVALUATION_DATA');
  assert.equal(report.horizons['1h'].candidateMae, null);
});
