import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePacket } from '../../contracts/src/index.ts';
import { canonicalOutput, generateScenario, outputHash, scenarios } from '../src/index.ts';

test('all eight scenarios produce valid simulator-only telemetry', () => {
  for (const scenario of scenarios) {
    const output = generateScenario(scenario, 7);
    assert.equal(output.metadata.source, 'simulator');
    assert.ok(output.packets.length > 0);
    for (const packet of output.packets) {
      const result = validatePacket(`irrigation/v1/simulations/${output.metadata.runId}/devices/sim-plant-01/telemetry`,
        Buffer.from(JSON.stringify(packet)));
      assert.equal(result.ok, true, `${scenario}: ${JSON.stringify(result)}`);
    }
  }
});

test('same seed gives byte-identical output and different seed changes it', () => {
  const first = generateScenario('sensor-noise', 42);
  const second = generateScenario('sensor-noise', 42);
  const other = generateScenario('sensor-noise', 43);
  assert.equal(canonicalOutput(first), canonicalOutput(second));
  assert.equal(outputHash(first), outputHash(second));
  assert.notEqual(outputHash(first), outputHash(other));
});

test('low tank has no pulse and missing samples contain a visible gap', () => {
  const empty = generateScenario('empty-reservoir', 7);
  assert.equal(empty.packets.some(p => p.payload.pumpOn), false);
  assert.ok(empty.packets.every(p => p.payload.state === 'LOCKOUT'));
  const missing = generateScenario('missing-samples', 7);
  assert.ok(missing.packets.some((p, i) => i > 0 && p.uptimeMs - missing.packets[i - 1].uptimeMs > 15 * 60 * 1000));
});
