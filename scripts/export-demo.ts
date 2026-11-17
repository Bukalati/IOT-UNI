import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate, openDatabase } from '../packages/data/src/index.ts';

const databasePath = process.env.SQLITE_PATH ?? resolve('data/demo.sqlite');
const outputPath = resolve('data/demo-export.json');
mkdirSync(resolve('data'), { recursive: true });
const db = openDatabase(databasePath);
migrate(db);
const runs = db.prepare(`SELECT id,scenario,seed,scenario_version,virtual_start_at,canonical_hash
  FROM simulation_runs ORDER BY id`).all();
const exportRuns = runs.map(run => {
  const rows = db.prepare(`SELECT received_at,packet_json,payload_hash FROM telemetry
    WHERE source='simulator' AND simulation_run_id=? ORDER BY boot_id,seq,id`).all(run.id as string);
  const records = rows.map(row => ({ receivedAt: row.received_at, packet: JSON.parse(row.packet_json as string),
    payloadHash: row.payload_hash }));
  const inputHash = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  return { run, rowCount: records.length, inputHash, records };
});
const document = { format: 'smart-irrigation-simulator-export-v1', source: 'simulator',
  runCount: exportRuns.length, rowCount: exportRuns.reduce((sum, item) => sum + item.rowCount, 0),
  runs: exportRuns };
writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, runCount: document.runCount, rowCount: document.rowCount,
  inputHashes: exportRuns.map(({ run, rowCount, inputHash }) => ({ id: run.id, rowCount, inputHash })) }, null, 2));
db.close();
