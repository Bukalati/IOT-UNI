import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ingestTelemetry, migrate, openDatabase, registerDevice, registerSimulationRun } from '../packages/data/src/index.ts';
import { generateScenario, outputHash, scenarios } from '../packages/simulator/src/index.ts';
import { validatePacket } from '../packages/contracts/src/index.ts';

const outputDir = resolve('data');
mkdirSync(outputDir, { recursive: true });
const db = openDatabase(process.env.SQLITE_PATH ?? resolve(outputDir, 'demo.sqlite'));
migrate(db);
const at = '2026-11-06T08:00:00.000Z';
if (!db.prepare("SELECT 1 FROM devices WHERE id='sim-plant-01'").get())
  registerDevice(db, 'sim-plant-01', 'simulator', 'گیاه شبیه‌سازی‌شده', at);
const manifest: { runId: string; scenario: string; seed: number; packetCount: number; sha256: string }[] = [];
for (const scenario of scenarios) {
  const output = generateScenario(scenario, 7);
  const hash = outputHash(output);
  const prior = db.prepare('SELECT canonical_hash FROM simulation_runs WHERE id=?').get(output.metadata.runId);
  if (prior && prior.canonical_hash !== hash) throw new Error(`Run hash conflict: ${output.metadata.runId}`);
  if (!prior) registerSimulationRun(db, { id: output.metadata.runId, seed: 7, scenario,
    scenarioVersion: output.metadata.scenarioVersion, virtualStartAt: at, canonicalHash: hash });
  for (const packet of output.packets) {
    const topic = `irrigation/v1/simulations/${output.metadata.runId}/devices/sim-plant-01/telemetry`;
    const validated = validatePacket(topic, Buffer.from(JSON.stringify(packet)));
    if (!validated.ok) throw new Error(`${scenario}: ${validated.detail}`);
    const receipt = new Date(Date.parse(packet.sentAt) + 100).toISOString();
    const result = ingestTelemetry(db, validated.packet, validated.identity, receipt);
    if (result !== 'inserted' && result !== 'duplicate') throw new Error(`Unexpected ingest result: ${result}`);
  }
  manifest.push({ runId: output.metadata.runId, scenario, seed: 7, packetCount: output.packets.length, sha256: hash });
}
writeFileSync(resolve(outputDir, 'demo-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ runs: manifest.length, rows: manifest.reduce((sum, run) => sum + run.packetCount, 0), manifest }, null, 2));
db.close();
