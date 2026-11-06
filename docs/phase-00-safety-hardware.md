# Firmware safety and hardware compatibility review

Status: **accepted software/simulation policy; hardware verification OPEN**. Draft §§3, 6 and 8 define components and provisional pins. User Phase 00 Finalization v2 accepts the numeric software defaults below. No device or electrical tests have been executed. “Pump off” means firmware drives its gate low; a failed-short MOSFET or miswired pump cannot be detected without independent hardware feedback. The [Plant Intelligence Engine](phase-00-intelligence.md) is never consulted by this control loop.

## Accepted software policy

| Parameter | Value | Semantics |
|---|---:|---|
| Soil sampling | 5,000 ms | Monotonic periodic schedule; a missed slot is not fabricated. |
| Maximum soil sample age | 15,000 ms | Age measured from acquisition using device monotonic clock; `age >= 15,000` is stale. Tank freshness uses the same limit until a separately reviewed setting exists. |
| Dry / wet threshold | 30% / 45% | Dry qualifies at `<30`; wet reset and auto-cycle termination at `>=45`; between thresholds retains hysteresis state. |
| Manual wet cutoff | 45% | A button or web request at `>=45` is rejected; manual need not be below 30 but must pass every other guard. |
| Consecutive dry samples | 3 | Three distinct, fresh, calibrated samples `<30` at scheduled sample slots; any nonqualifying/invalid sample resets count. |
| Default / maximum pulse | 2,000 / 3,000 ms | Default requested duration 2 s; every request must be `>0` and `<=3,000`; hard cutoff is at `min(request deadline, hard deadline, remaining budget)`. |
| Soak / pulses per cycle | 60,000 ms / 3 | Soak begins at gate OFF. No queued request survives soak; a new auto pulse requires a fresh post-soak sample and guards. |
| Runtime budget | 20,000 ms | Maximum commanded gate-ON time in a **trusted rolling 24 h**; persistent conservative accounting below. |
| Remote command TTL | 10,000 ms | API sets `expiresAt=createdAt+10 s`; device accepts only while `createdAt <= trusted UTC < expiresAt` and boot matches. |
| Status stale | 30,000 ms | Backend marks status stale when no fresh device evidence for `>=30 s`, regardless of retained online status. |
| Detected trip response target | <=100 ms | Deterministic test target from safety event detection/enqueue to gate OFF; includes queue/control scheduling, excludes undetectable hardware faults. |

These values are for simulator/software verification only, not physically validated watering recommendations. **Unsupervised real AUTO watering remains disabled** until H02/H03 calibration and H05–H07 supervised electrical/wet tests are signed off. H07 may exercise AUTO only through a local, time-limited supervised commissioning mode with an operator present, water isolated from electronics and the same safety guards; that mode expires to OFF and cannot be enabled over MQTT or by analytics. The normal physical AUTO enable flag is persisted locally, defaults false after first flash or invalid storage, and is set only after signed H07 evidence. H08 remains final acceptance.

## Safety invariants

1. Gate output is configured OFF before network, display or sensor initialization; external pulldown keeps it OFF during reset/boot. A software maximum-on timer is armed before gate ON and is independent of MQTT/UI tasks. Watchdog recovery must return to OFF. Verify all of this on the purchased board.
2. Every start path (auto, physical button, web) uses one guard: calibrated and fresh soil, soil below the 45% manual wet cutoff, tank valid/fresh and above calibrated minimum, no fault/lockout, enough remaining runtime budget, valid pulse count, and requested duration within hard bound. AUTO additionally requires three dry samples and physical commissioning. The draft says manual respects all safety constraints.
3. Tank `unknown`, soil invalid, sensor timeout, budget exhaustion, power/brownout recovery uncertainty, or impossible calibration blocks new starts. During WATERING, tank invalid/low or max runtime stops the pump immediately; soil readings during a pulse need not be trusted to stop the pulse because time cutoff is mandatory.
4. A pump start reserves its full requested duration against the persistent budget before gate ON. On normal gate OFF, a durable actual-duration record may release unused reserve; on crash, the full reservation remains charged. For trusted UTC starts, the reservation is stored with UTC start time and counts in every rolling `[now-24 h,now]` calculation. An unknown-time start creates undated debt. Reboot or untrusted time never ages out debt or replenishes budget. After clock trust is restored, undated debt remains charged until **24 h of continuous trusted monotonic uptime** has elapsed since restoration; any reboot or loss of trust restarts that wait. If storage is corrupt/unavailable, enter FAULT with gate OFF. This is conservative and may block watering longer than 24 h, which is safer than inadvertent budget reset.
5. State transitions and gate writes run in one control task. MQTT, button, sensors and timers send bounded events into that task. A full queue, task fault or watchdog reset must not leave the output ON. Two simultaneous requests cannot generate overlapping pulses.
6. `FAULT` is latched for integrity faults (invalid calibration, impossible sensor behavior, storage corruption, driver control failure if detectable). `LOCKOUT` is a reversible policy block (low/unknown tank, budget, cooldown or clock uncertainty). Classification and clearing are visible and logged. No remote command clears a fault or bypasses a guard.
7. Uncalibrated and simulated readings are never treated as valid physical measurements. A firmware build must not accept simulator-origin commands on a physical device.

The numeric software defaults are accepted for deterministic tests; physical suitability, tank minimum and electrical cutoff remain OPEN. The values are not validated safe quantities for the actual plant, pump or reservoir.

## Transition table

| Current | Event/guard | Next | Gate/action |
|---|---|---|---|
| boot/reset | initialization | LOCKOUT | Gate OFF first; load and validate calibration, settings, budget and command ledger; no auto start from a persisted request. Physical AUTO enable remains false unless signed commissioning flag is valid. |
| LOCKOUT | all guards become valid and fault absent | IDLE | Gate OFF; require a fresh sample and debounce window before auto trigger. |
| IDLE | qualifying dry samples in AUTO, or safe button/web request | WATERING | Reserve budget and request identity, arm cutoff, then gate ON; one pulse only. |
| IDLE | invalid/low tank, exhausted budget or required cooldown | LOCKOUT | Gate OFF; publish reason when connected. |
| any except WATERING | integrity fault | FAULT | Gate OFF; latch reason. |
| WATERING | pulse deadline or earlier safety trip | SOAKING / LOCKOUT / FAULT | Gate OFF before logging/publishing; record actual runtime and reason. Safety trip chooses LOCKOUT or FAULT by classification. |
| SOAKING | soak deadline and fresh valid samples | IDLE | Gate OFF; if dry and pulse allowance remains, next control iteration may start another pulse. |
| SOAKING | low/unknown tank or budget exhausted | LOCKOUT | Gate OFF. |
| LOCKOUT | fault discovered | FAULT | Gate OFF and latch. |
| FAULT | physical/service clear plus valid checks | LOCKOUT | Gate OFF; no immediate pulse. |
| any | reset, watchdog or brownout | boot/reset | Hardware default OFF; stale command is never replayed. |

`SOAKING` prevents immediate repeat; `LOCKOUT` carries a reason and explicit recovery condition. Concurrent priority is: hard deadline/watchdog and safety trip → gate OFF/state update → sensor/timer events → new button/remote requests. A manual request received while WATERING/SOAKING/LOCKOUT/FAULT is rejected with `BUSY_OR_LOCKED`; it is never deferred as an actuation intent. One cycle ends when wet threshold reached, three pulses used or any safety block occurs. At the exact boundary, `>=45` is wet, `<30` is dry, `age>=15 s` is stale, and a pulse deadline is exclusive (gate OFF at or before it). Use monotonic time for sample, pulse and soak timers; trusted UTC is required only for command expiry and rolling-window aging. On `uptimeMs` wrap or nonmonotonic time, gate OFF and FAULT. A dry sensor stuck at a plausible value cannot be diagnosed reliably without independent sensing; the budget and pulse cap limit consequences.

`LOCKOUT` reasons include `TANK_UNSAFE`, `BUDGET_EXHAUSTED`, `COMMISSIONING_REQUIRED`, `SENSOR_STALE` and temporary cooldown; it clears only after a fresh valid check (and required commissioning). `FAULT` latches for corrupt calibration/ledger, impossible state or detected control fault and requires physical/service clear followed by fresh checks. A network command cannot clear either. A stale tank/soil sample during WATERING is a detected safety trip; gate OFF within the 100 ms deterministic target. MQTT and analytics failure cannot prevent local cutoff. A physical button remains a manual request even if Wi-Fi/time is unavailable, but still needs calibration, tank safety and budget.

## Hardware compatibility and H00 evidence

| Item | Design check | Status |
|---|---|---|
| ESP32-WROOM-32 DevKit | GPIO34 is ADC1 input; GPIO34–39 have no software pull-up/down and ADC2 conflicts with Wi-Fi on ESP32. Provisional pins avoid strapping pins. Confirm exact board labels and exposed pins. [Espressif GPIO guide](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/peripherals/gpio.html). | OPEN: board not purchased/identified. |
| Soil sensor | Measure maximum analog output at its intended supply, under dry/wet conditions; keep ADC input within board limits. Choose ADC attenuation/calibration for observed range and record calibration endpoints, polarity and minimum separation. | OPEN: exact sensor and output unknown. |
| SRF05 | Manufacturer specifies 5 V supply and TTL Echo; use divider/level shifter to ESP32, check trigger input recognition at 3.3 V, mount perpendicular to water and validate tank geometry/near-field. [Manufacturer](https://www.robot-electronics.co.uk/htm/srf05tech.htm). | OPEN: exact unit and electrical behavior untested. |
| OLED | Check controller (for example SSD1306 versus SH1106), I2C address, supply and pull-up rail; do not assume 5 V pull-ups are safe. | OPEN. |
| Pump/driver/supply | Measure or obtain pump startup/stall current, supply voltage/current capability, MOSFET 3.3 V gate performance, diode orientation/rating, wiring gauge, common ground and gate pulldown. ESP32 pin cannot drive pump directly. Isolate wet tubing from electronics. | OPEN; no power test performed. |
| Button/LED | Verify button active level/debounce and LED resistor/current on chosen pins. | OPEN. |
| Reset behavior | Measure gate/pump during power-up, brownout, firmware reset and watchdog reset with water isolated. | OPEN; safety gate for H05/H06. |

The [ESP32-WROOM-32 datasheet](https://documentation.espressif.com/esp32-wroom-32_datasheet_en.html) documents 3.3 V operation and input limits; it does not establish the safety of an unidentified breakout board. The SRF05 and pump wiring must be checked before connection. No mains switching is within scope. A low-cost optional improvement to consider after measurement is a normally-off, independently timed power switch; price and complexity should be compared with the demonstration requirements before adopting it.

## Verification design (unexecuted)

Unit tests with a fake monotonic clock and fake gate must assert every transition and invariant, including simultaneous requests, stuck dry sensor, tank becoming unknown during a pulse, queue overflow, and cutoff when network tasks stall. Fault injection must cover durable ledger write failure and resets at each command lifecycle boundary. Hardware checklist H00–H08 from the draft must record part identifiers, wiring diagram, measured voltage/current, serial logs, screenshots/video and operator sign-off. A real wet test is required before any claim that the system prevents dry running or overwatering under the chosen setup. Software-only evidence supports bounded commanded runtime, not detection of a stuck-on electrical fault.
