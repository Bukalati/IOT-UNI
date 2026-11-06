import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluate } from '../packages/intelligence/src/evaluate.ts';
import type { Point } from '../packages/intelligence/src/index.ts';

const start = Date.parse('2026-11-06T00:00:00.000Z');
const points: Point[] = Array.from({ length: 8641 }, (_, index) => {
  const measuredAt = new Date(start + index * 5000).toISOString();
  return { id: index + 1, deviceId: 'sim-eval-01', source: 'simulator', runId: 'eval-seed-7',
    measuredAt, receivedAt: new Date(start + index * 5000 + 100).toISOString(),
    soilPercent: Math.round((48 - 1.5 * index * 5000 / 3600000) * 100) / 100,
    soilQuality: 'calibrated', calibrationRevision: 1, bootId: 'eval-virtual-boot',
    seq: index + 1, timeTrusted: true };
});
const report = evaluate({ deviceId: 'sim-eval-01', source: 'simulator', runId: 'eval-seed-7', points });
mkdirSync('data', { recursive: true });
writeFileSync('data/evaluation-demo.json', `${JSON.stringify({ fixtureVersion: '1', seed: 7,
  virtualStartAt: new Date(start).toISOString(), sampleIntervalMs: 5000, pointCount: points.length,
  report }, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
