# Software delivery and demo guide

Updated: 2026-11-17. This guide covers the software demo that can run before hardware is selected. It does not claim a tested ESP32 firmware image, electrical safety, watering performance, or physical forecast accuracy.

## Run the demo

Use Node.js 24.21.0 and npm 11.19.0. From the repository root:

1. Run `npm ci`.
2. Generate local broker users with `python3 broker/init_secrets.py`.
3. Create the operator password and local API configuration with `npm run setup:local`. The password is written to ignored `broker/secrets/operator-password.txt`.
4. Start Mosquitto with `docker compose up -d broker`.
5. Seed the demo using `npm run seed:demo`, then run `npm run analyze:demo` and `npm run evaluate:demo`.
6. Create a portable simulation-only evidence file with `npm run export:demo`. It writes `data/demo-export.json` with source packets, receipt times, row hashes and deterministic input hashes. It never exports physical-device telemetry.
7. In separate terminals run `npm run dev:api` and `npm run dev:web`; open `http://127.0.0.1:3000/` and sign in with the generated operator password.
8. Select the simulator and the gradual-drying run to view its history and advisory analysis. Select other scenarios to see distinct data quality and safety states.

Stop the web and API processes with Ctrl+C. Stop only the local broker container with `docker compose down`. Local secrets and generated demo data remain ignored by Git.

## Demonstration sequence

1. Show the physical device has no readings and that a physical command is locked until commissioning.
2. Select the gradual-drying simulator run; show the soil chart, separate measurement and receipt times, source label, and analysis provenance.
3. Select missing-samples and insufficient-history scenarios; show the gaps and explicit abstention.
4. Show active alerts and reported calibration state. Calibration is reported as unknown until measured data arrives; the dashboard does not invent or edit calibration.
5. Explain that the simulated forecast evaluation uses chronological holdout and reports the baseline alongside the candidate. The current synthetic fixture gives no eligible 3-hour origins and the baseline slightly wins the measured 1-hour/crossing comparisons.

## Results that can be stated

- Source identity and simulator-run provenance are checked by contracts and storage constraints.
- Simulator output is repeatable for a fixed seed.
- Analysis abstains on insufficient history and keeps its outputs outside the control tables.
- Current verification is local software and a local Mosquitto broker. It is not a remote CI run, a physical-device test, or an agricultural recommendation.

## Suggested presentation outline

1. **Problem and goal:** demonstrate a traceable plant-moisture monitoring and irrigation workflow.
2. **System shape:** ESP32 is intended to own local safety; MQTT carries messages; Fastify/SQLite validates and stores them; Next.js presents them; analytics is advisory.
3. **Software demonstration:** simulator scenarios, gaps/quality labels, authenticated dashboard, alert and calibration states.
4. **Safety boundary:** physical actuation remains locked; the simulator cannot impersonate the physical device; analytics cannot command the pump.
5. **Evaluation:** describe the time-ordered synthetic evaluation, include sample counts and baseline, and state its limited value.
6. **Unfinished evidence:** exact parts and GPIO map, firmware build/flash, sensor calibration, driver cutoff/reset tests, supervised water test, physical MQTT logs, and physical model evaluation.
7. **Next work:** after the parts are identified, perform H00–H08 in order and update the report only with measured evidence.

## Current technical gates

The device firmware, board-specific pins, calibration measurements, device-side ACK/reconnect proof, and actual pump operation require board/parts information and signed measurements. The server has an authenticated, validated settings request route backed by a durable outbox, but production still blocks it until commissioning. A normal server deployment never turns on the hardware commissioning flag. Do not describe the current software as a completed irrigation controller.
