# Smart Irrigation IoT — implementation record

Date: 2026-11-17. Phase 00 was reviewed in full before implementation: PRD, intelligence, contracts, safety-hardware, data, plan, review, and final-summary. This record distinguishes executed checks from the hardware evidence that is still missing.

## Phase gates

`PASS` means every planned acceptance check has recorded evidence; `PARTIAL` means code exists but a required check or dependency is missing; `FAIL` means a safety, identity, or contract invariant failed. The statuses below use that definition from the Phase 00 plan.

| Phase | Result | Implemented and verified | Remaining gate |
| --- | --- | --- | --- |
| P01 bootstrap | **PARTIAL** | Pinned npm monorepo; repeatable install, lint, typecheck and build; local Mosquitto with separate physical/sim identities and ACL; Fastify health and Next.js Persian RTL browser smoke; CI workflow created. | P01-S04 ESP-IDF build/flash and serial record require H00/H01. Remote CI runner has not executed. |
| P02 contracts, data, simulator | **PARTIAL** | Executable MQTT JSON Schemas and negative cases; SQLite STRICT migrations, constraints, durable command/outbox repository and replay checks; virtual-clock eight-scenario simulator with reproducible hashes; seeded rows carry source, run, seed and scenario. | Full planned packet/replay negative matrix and retention/export review are not complete. |
| P03 MQTT and backend | **PARTIAL** | Real Mosquitto telemetry ingestion into SQLite; payload/topic/source validation, dedup/conflict; session, CSRF and origin checks; command API with durable outbox and default hardware lock; status age and SSE snapshot/reconnect tests. | Device-side ACK/reconnect behavior, settings publish path, and full crash-boundary integration remain unverified. No physical device exists. |
| P04 firmware | **NOT STARTED — HARDWARE GATE** | Safety policy and proposed firmware order are documented in Phase 00. | H00 exact board, GPIO/voltage/pump and sensor evidence is absent, as is ESP-IDF. No firmware artifact, HAL, flash, or bench claim is made. |
| P05 dashboard | **PARTIAL** | Next.js Persian RTL dashboard; operator login; physical/sim selector; status, moisture history with gaps, measured/received time, provenance and advisory view; active alerts and reported calibration are now visible through authenticated API routes. Basic keyboard focus, labels and alert semantics are in place. | Desired/reported settings history is still minimal; calibration edits intentionally require physical measurements; formal accessibility review and a fresh browser smoke after the latest dashboard change remain. |
| P06 intelligence | **PARTIAL** | Versioned advisory engine with validated-history quality gates, OLS forecast, last-rate baseline, MAD anomaly candidates, Persian insight templates, persisted analysis and UI cards. Time-ordered simulated evaluation and no-control-write tests run. | No physical accuracy evidence; 3 h evaluation has zero eligible origins; additional pulse/response fixtures and broader evaluation are needed. |
| P07 integration/security | **PARTIAL** | Software demo seeds eight scenarios; real broker ACL matrix and broker-to-DB integration pass; session/CSRF/origin tests, authenticated alert/calibration API tests and analytics isolation tests pass. | Firmware-to-backend flow, power/reset/offline fault injection and H05–H07 supervised bench tests are absent. |
| P08 final evidence | **PARTIAL** | Software setup/demo walkthrough and defense outline are documented in [software-delivery.md](software-delivery.md); local test/build record is below. | H08 signed hardware checklist, another-operator setup replay, final review and physical defense evidence remain. |

## Executed verification

The local environment used Node 24.21.0, npm 11.19.0, TypeScript 5.9.3, Fastify 5.12.8, Next.js 16.4.5, Mosquitto 2.0.22 and Node's SQLite 3.53.4. `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` completed successfully after the alert/calibration change. The regular suite passed 32 tests, failed 0, and skipped the 1 broker-dependent case; `npm run test:mqtt -w @irrigation/api` separately passed 1 test after starting the local Docker broker. `python3 broker/test_acl.py` passed 8 publish allow/deny cases and 4 delivery allow/deny cases. An earlier browser smoke checked actual login, physical no-data, gradual-drying and missing-samples scenarios, and a 375 px viewport with no horizontal overflow; a browser smoke after the latest UI change remains outstanding. This is local execution, not remote CI or hardware evidence.

The demo seed created eight simulator runs and 5,573 telemetry rows in ignored `data/demo.sqlite`; rerunning the seed was idempotent. The analysis runner stored eight advisory results. A separate 8,641-point, 12-hour deterministic fixture produced the time-ordered evaluation in ignored `data/evaluation-demo.json`: 3 eligible origins and 3 valid candidate forecasts; at 1 h, 2 eligible comparisons, candidate MAE `0.00008400115567397393` percentage points versus baseline MAE `7.105427357601002e-15`; at 3 h, 0 eligible comparisons, so no MAE. For 3 observed threshold crossings, candidate MAE was `0.17015555555555553` minutes versus baseline `0.16666666666666666` minutes. These numbers describe only the synthetic fixture. The baseline marginally wins it; the result is not evidence of useful real-world forecast accuracy.

## Safety boundary and next dependency

The running API never enables `hardwareCommissioned`; command requests return `HARDWARE_NOT_COMMISSIONED`. Only isolated tests inject that flag with a fake publisher/database. Analytics has no MQTT publisher or command/settings write path. Simulator identity and credentials are separate from physical identity. No pump, GPIO, board, wiring, calibration, flash or wet test was performed.

H00 needs exact board and module identifiers, intended GPIO map, supply and pump ratings, MOSFET/diode/pulldown details, and measured safe sensor levels. H01–H07 then govern firmware flash, calibration, electrical cutoff and supervised watering. Real AUTO and any pump connection must wait for those signed checks. Firmware work should follow the Phase 00 order: pin proof and mockable HAL, sensors and calibration, persistent ledger/budget, local cutoff/state machine, then MQTT. Software defaults remain simulation parameters only.

## Main changed paths

- Root manifests, lockfile, CI workflow, broker configuration and local setup scripts.
- `packages/contracts`, `packages/data`, `packages/simulator`, `packages/intelligence`.
- `apps/api` Fastify service and `apps/web` Next.js dashboard.
- `scripts/seed-demo.ts`, `scripts/analyze-demo.ts`, `scripts/evaluate-demo.ts`.
- `docs/software-delivery.md` demo walkthrough and presentation outline.

Generated secrets, local `.env`, SQLite database and evaluation JSON are ignored by Git. The eight Phase 00 documents remain the design baseline; this record reports implementation separately.
