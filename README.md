# Smart Irrigation IoT

Software-first implementation of the [Phase 00 design](docs/phase-00-final-summary.md). The current system supports a validated MQTT/SQLite path, a seeded simulator, a Persian RTL dashboard, authenticated API/SSE, and advisory analytics. **Physical pump actuation is disabled in the running server.** No firmware, wiring, calibration, electrical measurement, or wet test has passed.

## Pinned local stack

Node.js 24.21.0, npm 11.19.0, Fastify 5.12.8, Next.js 16.4.5, TypeScript 5.9.3, Mosquitto 2.0.22, and SQLite 3.53.4 bundled with the tested Node runtime. ESP-IDF is not installed here; its patch version and board-specific pins remain part of H00/P04. Package versions are fixed in `package-lock.json`. The API, web app, and broker bind to loopback for software work.

## First run

1. Select Node 24.21.0 (`.nvmrc`) and run `npm ci`.
2. Run `python3 broker/init_secrets.py`, then `npm run setup:local`. The generated operator password is in ignored `broker/secrets/operator-password.txt`; `.env` and all broker credentials are ignored. Do not commit or share them.
3. Run `docker compose up -d broker` and `python3 broker/test_acl.py`.
4. Run `npm run seed:demo` and `npm run analyze:demo` to create eight repeatable simulated runs in `data/demo.sqlite`. `npm run evaluate:demo` writes a separate, time-ordered simulated evaluation to `data/evaluation-demo.json`; `npm run export:demo` writes a provenance-labeled simulator-only evidence export.
5. In separate terminals run `npm run dev:api` and `npm run dev:web`; open `http://127.0.0.1:3000/`. The Next.js app proxies `/backend/*` to the local API, so browser sessions remain on one origin. API health is at `http://127.0.0.1:3001/health`.

The seeded device is visibly marked as a simulator; choose its scenario from the selector. The physical device has no readings until real telemetry is commissioned. The dashboard shows active alerts and the latest reported calibration. Calibration editing stays unavailable because calibration values must come from physical measurements. The simulator does not connect to the pump or impersonate `plant-01`.

## Checks

Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. With the local broker running and credentials generated, run `npm run test:mqtt -w @irrigation/api` for the actual broker-to-SQLite integration test. The regular test command skips only that environment-dependent integration case. `python3 broker/test_acl.py` checks allowed and denied publishes and deliveries.

## Safety and scope

The server does not pass the `hardwareCommissioned` flag, so command and settings routes return `HARDWARE_NOT_COMMISSIONED` even when a device appears online. Test code enables that flag only against a fake database/publisher. No current software result validates electrical cutoff, MOSFET behavior, tank geometry, soil calibration, or actual water flow. Do not attach a real pump or enable AUTO before H00–H07 evidence and firmware safety tests are complete.

The analytics engine reads persisted validated telemetry and writes only `analysis_runs`, `predictions`, and `insights`. It has no MQTT publisher or command/settings write path. Simulated evaluation results are not physical accuracy claims. See [the execution record](docs/implementation-status.md) for phase gates and evidence, and [the software delivery guide](docs/software-delivery.md) for the demo walkthrough and presentation outline.
