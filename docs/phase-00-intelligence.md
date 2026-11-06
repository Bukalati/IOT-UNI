# Plant Intelligence Engine — Phase 00 design

Status: **accepted advisory architecture, proposed versioned algorithm parameters**. No model has been trained or evaluated. This is a lightweight TypeScript module inside the Fastify backend. It reads validated, committed SQLite history and writes analysis results through dedicated repositories. It cannot publish MQTT, create commands, edit device settings/calibration/budget or clear faults. The ESP32 control loop never waits for it. See [PRD](phase-00-prd.md), [data model](phase-00-data.md) and ADR-14–19 in the [plan](phase-00-plan.md#adr-register).

## Input and output contract

Input is an ordered series for one physical `device_id` or one simulation `(run_id,device_id)`, plus effective reported settings and validated irrigation pulse summaries. Each point contains `telemetry_id`, `soil_percent`, `soil_quality`, `measured_at`, `received_at`, `boot_id`, `seq`, `calibration_revision`, `source`; events contain pulse start/end and outcome. Use `measured_at` **only when the device indicated trusted UTC**. `received_at` is provenance/latency information and is not a substitute for acquisition time. Exclude duplicate, invalid, uncalibrated, stale, nonnumeric, out-of-range, unknown-time and wrong-provenance rows. A calibration revision change or watering jump starts a new segment. Preserve input row IDs/hash, source, run ID, algorithm/config version, window and generation time in every run.

Output is a versioned `AnalysisResult` with `runId`, identity/provenance, `algorithmVersion`, `configHash`, window, sample count, valid coverage, status and reason. Optional typed components: `trend` (rolling mean/median, slope, rate, quality), `prediction` (status, crossing time nullable, forecast horizon, fit metrics), and `anomalies`/Persian `insights`. Analysis status is not a safety state. An API may read results; no analytics MQTT topic is justified.

## Time windows and quality gates

Initial **algorithm-test defaults**: look back at most 24 h, use the latest stable drying segment after the most recent completed irrigation pulse or calibration change, require at least 12 valid distinct samples spanning at least 60 min, at least 80% expected temporal coverage under the actual configured sample interval, and no individual gap above 15 min within the fitted segment. Because the firmware samples every 5 s, a sparse series of only 12 points across 60 min will fail the 80% coverage gate; count and coverage are independent. For a university demo, a shorter virtual-time fixture can test abstention separately; do not relax gates just to display a forecast. Exact analytic thresholds and configuration hash are versioned, not firmware settings.

Define expected sample slots from the device's reported sampling interval over `[first_measured_at,last_measured_at]`; coverage is occupied unique slots / expected slots, capped at 1. Choose at most one reading per slot in sequence order. Reject nonmonotonic trusted timestamps, impossible uptime/UTC ordering, and mixed physical/simulation identities. A backend outage creates missing coverage unless the device truly buffered and later supplied trusted acquisition timestamps. The engine can still show a quality/coverage explanation when prediction is withheld.

## Trend and forecast mathematics

For valid observations `(t_i,y_i)` in a stable segment, `y_i` is soil percentage points and `x_i=(t_i-t_0)` in hours. Rolling mean is `sum(y_i)/n`; rolling median is the middle value (or mean of two middle values) in a trailing 60 min window, with sample count and coverage. `moisture_change_pp = y_last - y_first`; observed rate is this change divided by elapsed hours. Report the units as percentage points per hour, not relative percent per hour.

Candidate v1 is ordinary least squares `y = a + b x`, where `b = Σ(x_i-x̄)(y_i-ȳ)/Σ(x_i-x̄)^2` and `a=ȳ-bx̄`. Reject if denominator is zero, values are nonfinite, or the latest segment is not a drying segment. Initial validity gates: `b <= -0.25` percentage points/hour, `R² >= 0.60`, residual median absolute deviation no greater than 3 percentage points, no watering/discontinuity inside the fit window, and a threshold crossing strictly after the analysis time but within 24 h. `R²=1-SSE/SST`; if `SST=0`, classify `UNRELIABLE_TREND`. If current moisture is already at/below dry threshold, return `UNRELIABLE_TREND/ALREADY_DRY` rather than a future crossing estimate. Crossing at `x*=(dry_threshold-a)/b`; convert to UTC only if all time gates pass. These thresholds are deterministic design defaults for evaluation, not proven predictive performance or botanical advice.

Prediction lifecycle: `INSUFFICIENT_DATA` for count/coverage/time-quality failures; `UNRELIABLE_TREND` for flat/increasing/noisy/poor-fit/out-of-horizon or discontinuous segments; `VALID` only after all gates. Every result includes a reason code, `algorithmVersion`, `trainingStart/End`, `sampleCount`, `coverage`, slope, `R²`, residual MAD, dry threshold and horizon. No confidence interval or probability is displayed in v1. A future uncertainty method requires a separately documented validation design.

Reason-code registry v1: `TOO_FEW_SAMPLES`, `TOO_SHORT_WINDOW`, `LOW_COVERAGE`, `GAP_TOO_LARGE`, `TIME_UNTRUSTED`, `MIXED_PROVENANCE`, `CALIBRATION_CHANGED`, `WATERING_DISCONTINUITY`, `FLAT_TREND`, `INCREASING_TREND`, `NOISY_TREND`, `POOR_FIT`, `ALREADY_DRY`, `CROSSING_OUT_OF_HORIZON`, `NONFINITE_INPUT`, `ZERO_TIME_VARIANCE`, `EVALUATION_DATA_INSUFFICIENT`. These are analytics explanations only; firmware never interprets them. A `VALID` prediction has no rejection reason. Unknown version/code is rejected by the analytics API schema rather than silently interpreted.

## Robust anomaly detection

Use a trailing comparison window of at least 12 valid points with at least 60 min coverage for rate anomalies; use local first differences `d_i=(y_i-y_(i-1))/Δt_hours` only for gaps within the allowed interval. Let `m=median(d_i)`, `MAD=median(|d_i-m|)`, and `robustScale=1.4826×MAD`. NIST describes MAD as a robust scale statistic: [NIST handbook](https://www.itl.nist.gov/div898/handbook/eda/section3/eda356.htm). Flag a candidate rapid-drying or jump residual only when its magnitude exceeds both `3×robustScale` and an absolute floor (initial floor 5 percentage points for a single jump; 2 percentage points/hour for rate), with sign/type-specific direction. If MAD is zero, use `IQR/1.349` when nonzero; if both are zero, use the absolute floor alone. This prevents division by zero and avoids labeling every tiny quantization change anomalous. All limits are algorithm versioned and must be tested against fixtures.

Additional candidates: `STUCK_READING` when calibrated values remain within 0.5 percentage point for at least 6 h with adequate samples/coverage; `WEAK_POST_WATERING_RESPONSE` when median 10–30 min after a completed pulse rises by less than 2 percentage points versus the 10 min pre-pulse median, with both windows valid and no intervening pulse; `UNEXPECTED_JUMP` for a large step without a matching watering event; `RAPID_DRYING` for a negative rate outlier. A pump pulse is an observed command/event, not proof that water flowed. These flags suggest investigation and never assert a sensor/pump/plumbing failure. Missing/invalid data produces no anomaly or an explicit unevaluable status.

Each anomaly has `type`, `severity` (`info/warning` for v1), `evidenceStart/End`, point/event IDs or hash, observed statistic, comparison threshold, algorithm/version, source/run ID and human-readable explanation. Severity reflects evidence strength and urgency of review, not a physical diagnosis.

## Explainable Persian insights

Template selection uses computed `trend/prediction/anomaly` fields only. Examples of templates, **not observations**: “رطوبت خاک در بازهٔ بررسی روند کاهشی داشته است.”; “برآورد رسیدن به آستانهٔ خشکی بر پایهٔ داده‌های معتبر اخیر است.”; “تغییر رطوبت پس از آبیاری کمتر از مقدار مورد انتظار در این بازه بوده است.” Each rendered card shows window, sample count, quality/status, measured versus simulated label, algorithm version and evidence link. A prediction card says “برآورد” and displays its validity status; it does not say watering is needed or issue a command. An abstention card explains why no prediction was produced.

## Reproducible evaluation

Baseline v1: fit no regression. At an evaluation origin, take the median of valid soil values in the last 10 min and the median in the preceding 10 min; divide their difference by the separation of window midpoints to get a last-observed rate. Extrapolate linearly from the recent median. If either window lacks coverage or rate is nonnegative, baseline abstains on crossing time; its moisture forecast can still use persistence (`last median`) as a separately reported fallback. Candidate and baseline use the **same eligible origins and input cutoff**.

For each device/run, sort by trusted `measured_at`, then split chronologically. A fixed last 20% is holdout only when enough points and at least 2 h remain; otherwise report `INSUFFICIENT_EVALUATION_DATA`. Where volume allows, roll origin forward in 1 h steps, train strictly on rows at/before origin and score on rows after origin, never crossing an irrigation/calibration discontinuity. Configuration tuning must use earlier training folds only, not the holdout. Time-aware splitting and leakage avoidance follow [scikit-learn's guidance](https://scikit-learn.org/stable/common_pitfalls) as a methodological reference; implementation remains TypeScript.

Evaluate moisture forecasts at 1 h and 3 h when an observed valid point exists within ±5 min of the horizon and no pulse intervenes. `MAE = sum(|predicted-observed|)/eligible_count`, reported separately by horizon, method and physical/simulated source. For crossing time, score only origins where a valid first crossing is observed within the 24 h horizon and no pulse/discontinuity intervenes; interpolate linearly between adjacent valid observations bracketing the crossing. Report absolute error in minutes and median/mean over eligible cases. Report eligible origins, valid forecasts, abstentions, coverage rate, missed observed crossings, false crossing forecasts, and reasons for exclusion. Do not aggregate simulated and physical metrics or invent accuracy numbers. Persist evaluation config, seed/run ID, algorithm version, input row range/hash and execution timestamp.

## Deterministic simulation matrix (unexecuted)

| Scenario | Expected analytic behavior / assertion |
|---|---|
| Gradual drying | Trend negative; forecast `VALID` only after all coverage/fit gates; crossing time computed from fitted line. |
| Watering increase | Segment resets at pulse; no fit across moisture jump; post-water response window can be evaluated. |
| Sensor noise | Rolling median damps isolated noise; noisy fit may abstain; thresholds use fixed seed. |
| Stuck constant sensor | `STUCK_READING` candidate after duration; forecast `UNRELIABLE_TREND`, never divide by zero. |
| Sudden jump | `UNEXPECTED_JUMP` candidate with evidence; fitting window excludes discontinuity. |
| Missing samples/network outage | Coverage/gap gate yields `INSUFFICIENT_DATA`; receipt-time interpolation is forbidden. |
| Empty reservoir | No watering event should be inferred; analytics may show tank context but cannot override lockout. |
| Insufficient history | `INSUFFICIENT_DATA`, nullable crossing, explicit reason and provenance. |

Simulation requires fixed seed, scenario/version, virtual UTC clock, canonical event ordering and byte-identical output on rerun. Ground truth from simulator is labeled simulated; real hardware requires separately collected evidence. No simulation or evaluation has been executed yet.

## Safety and limitations

The engine is advisory and isolated from actuation by module boundaries, API permissions, broker ACL and tests that assert zero writes to commands/settings/budgets and zero MQTT publications. Correlation between pulse and soil rise is not proof of water delivery. A single capacitive sensor is affected by placement, substrate, drift and calibration; linear extrapolation assumes a short, stable drying segment and can fail after environmental changes. Do not present a prediction as certain or use it to bypass firmware guards.
