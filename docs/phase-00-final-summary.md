# Smart Irrigation IoT — Phase 00 final gate summary

Date: 2026-11-06. **Overall design gate: PASS.** This means the Phase 00 documentation provides an accepted, testable software design. It does not mean implementation, algorithm accuracy, electrical safety or watering performance has been verified. No Phase 01 work has begun; explicit user approval is required before it starts.

## Accepted decisions and open hardware

| Status | ADRs | Meaning |
|---|---|---|
| ACCEPTED | 01–08, 12–19 | ESP32 actuation authority; MQTT clean session/idempotency; trusted-time/boot-bound commands; durable reservation; conservative budget; provenance isolation; desired/reported settings; Fastify/Next.js/SQLite/SSE; authenticated LAN; limited safety claims; advisory TypeScript intelligence with reproducibility, abstention and time-ordered evaluation. Full text in [ADR register](phase-00-plan.md#adr-register). |
| ACCEPTED_FOR_SIMULATION | 11 | 5 s sample, 15 s freshness, 30/45% thresholds, three dry samples, 2 s default/3 s max pulse, 60 s soak, three pulses/cycle, 20 s rolling 24 h budget, 10 s remote TTL, 30 s status stale and <=100 ms detected-trip target. Physical suitability is unverified. |
| OPEN_HARDWARE | 09–10 | Exact board/pins/sensors/OLED/pump/MOSFET/supply/electrical measurements; tank geometry, placement, calibration and safe level. H00–H08 must provide measured, signed evidence before real AUTO acceptance. |

## Resolved design findings

The [review disposition](phase-00-review.md#findings-disposition) closes the UTC-expiry contradiction by rejecting remote actuation when device time is untrusted; closes QoS 1 replay risk in design with boot binding and durable reservation; separates LWT status from sequenced telemetry; specifies persistent conservative budget accounting; applies one wet-soil guard to button/web; defines fault/lockout recovery; splits desired/reported settings; isolates simulator identities; separates trusted measurement time from server receipt time; and accepts the originally excluded ML scope only as an advisory module under the user's v2 request. The physical fail-safe claim remains intentionally limited because no pump feedback or redundant cutoff is specified.

## Intelligence requirement and academic evidence

The [Plant Intelligence Engine](phase-00-intelligence.md) consumes validated SQLite history, computes rolling trend/coverage, fits a versioned linear regression only on a stable post-watering segment, detects candidate anomalies with median/MAD and a zero-MAD fallback, and renders evidence-backed Persian insights. Forecast status is `INSUFFICIENT_DATA`, `UNRELIABLE_TREND` or `VALID`; invalid inputs yield no crossing time. Its outputs carry source, run/algorithm/config version, window, count, fit metrics and input hash. It has no MQTT publisher or command/settings/budget write path. The evaluation plan uses chronological holdout/rolling origins, a last-rate baseline, moisture MAE, observed crossing-time error, eligible case counts and abstention, with physical and simulated results separated. No model has been trained and no metrics have been measured.

## Readiness and remaining risks

| Area | Result | Evidence / limitation |
|---|---|---|
| Software architecture and contracts | PASS for design | [PRD](phase-00-prd.md), [MQTT contract](phase-00-contracts.md), [data model](phase-00-data.md), [safety](phase-00-safety-hardware.md), [plan](phase-00-plan.md) and intelligence spec define responsibilities, schema and tests. Executable schemas, migrations and code remain future tasks. |
| Testability | PASS for design | AC-01–18 and per-task verification define observable outcomes; deterministic eight-scenario matrix and chronological evaluation are specified. No future test is marked executed. |
| Hardware/electrical readiness | PARTIAL | [H00–H08](phase-00-plan.md#separate-hardware-track) and ADR-09/10 are OPEN_HARDWARE. Exact parts/voltage/current, gate OFF on reset and wet behavior are unmeasured. |
| Physical safety claim | PARTIAL | Firmware can bound commanded gate time in design; stuck MOSFET, failed pump, siphon/leak and sensor placement are not diagnosed without extra hardware. |
| Forecast accuracy | PARTIAL | Model/evaluation plan exists; no physical data, training or accuracy result exists. Single-sensor linear extrapolation can fail after environmental changes. |
| Phase 01 software bootstrap | READY FOR USER APPROVAL | Accepted stack and ADRs permit P01 software work after explicit approval. Board-specific P01-S04 waits for H00; no hardware item is treated as solved. |

## Phase 01 prerequisites and stop boundary

Before P01, the user must explicitly approve starting it. P01 should pin exact Node/package-manager, ESP-IDF patch, SQLite version and local host/deployment method in its bootstrap manifest; this is implementation setup, not an unresolved Phase 00 safety design decision. P01-S04 also needs H00 exact board/pin evidence. Real pump connection waits for H05 and unsupervised AUTO for signed H07. Keep the source-specific credentials and secrets outside the repository. Each future task stops at its own reported gate.

## Documentation consistency record

Phase 00 files are all under `docs/`: review, contracts, safety/hardware, data, plan, PRD, intelligence and this summary. Local automated document checks found eight Markdown files, valid relative links and heading anchors, parseable JSON examples, consistent table pipe counts, contiguous ADR-01–19 and AC-01–18. Git status showed only the untracked `docs/` directory; no non-document project file was created. These are document checks only, not application, model or hardware test results.
