import { createHash } from 'node:crypto';

export const algorithmVersion = '1.0.1';
export const defaults = { lookbackMs: 86400000, minSamples: 12, minSpanMs: 3600000,
  minCoverage: 0.8, maxGapMs: 900000, minSlopePpPerHour: -0.25,
  minR2: 0.6, maxResidualMadPp: 3, horizonMs: 86400000,
  dryThresholdPercent: 30, sampleIntervalMs: 5000 } as const;
export type Source = 'device' | 'simulator';
export type Point = { id: number | string; deviceId: string; source: Source; runId: string | null;
  measuredAt: string | null; receivedAt: string; soilPercent: number | null; soilQuality: string;
  calibrationRevision: number; bootId: string; seq: number; timeTrusted: boolean };
export type Pulse = { endedAt: string; id: string; actualMs: number };
export type Reason = 'TOO_FEW_SAMPLES' | 'TOO_SHORT_WINDOW' | 'LOW_COVERAGE' | 'GAP_TOO_LARGE' |
  'TIME_UNTRUSTED' | 'MIXED_PROVENANCE' | 'CALIBRATION_CHANGED' | 'WATERING_DISCONTINUITY' |
  'FLAT_TREND' | 'INCREASING_TREND' | 'NOISY_TREND' | 'POOR_FIT' | 'ALREADY_DRY' |
  'CROSSING_OUT_OF_HORIZON' | 'NONFINITE_INPUT' | 'ZERO_TIME_VARIANCE';
export type ForecastStatus = 'INSUFFICIENT_DATA' | 'UNRELIABLE_TREND' | 'VALID';
export type Anomaly = { type: 'UNEXPECTED_JUMP' | 'RAPID_DRYING' | 'STUCK_READING' | 'WEAK_POST_WATERING_RESPONSE';
  severity: 'info' | 'warning'; evidenceStart: string; evidenceEnd: string;
  observed: number; threshold: number; pointIds: (number | string)[]; source: Source; runId: string | null;
  algorithmVersion: string };
export type AnalysisResult = { id: string; deviceId: string; source: Source; runId: string | null;
  algorithmVersion: string; configHash: string; inputHash: string; trainingStart: string | null;
  trainingEnd: string | null; sampleCount: number; coverage: number | null; status: ForecastStatus;
  reason: Reason | null; trend: { mean: number; median: number; observedRatePpPerHour: number } | null;
  prediction: { crossingAt: string | null; slopePpPerHour: number | null; rSquared: number | null;
    residualMadPp: number | null; interceptPp: number | null; horizonMs: number; dryThresholdPercent: number };
  anomalies: Anomaly[]; insightsFa: string[] };

const reasonFa: Partial<Record<Reason, string>> = {
  TOO_FEW_SAMPLES: 'نمونه‌های معتبر کافی نیست', TOO_SHORT_WINDOW: 'بازهٔ اندازه‌گیری کوتاه است',
  LOW_COVERAGE: 'پوشش زمانی داده کافی نیست', GAP_TOO_LARGE: 'فاصلهٔ بدون داده زیاد است',
  TIME_UNTRUSTED: 'زمان اندازه‌گیری قابل اعتماد نیست', MIXED_PROVENANCE: 'منبع داده‌ها یکسان نیست',
  FLAT_TREND: 'روند رطوبت تقریباً ثابت است', INCREASING_TREND: 'رطوبت در حال افزایش است',
  POOR_FIT: 'روند خطی با داده‌ها خوب برازش نمی‌شود', NOISY_TREND: 'نوسان داده زیاد است',
  ALREADY_DRY: 'رطوبت هم‌اکنون به آستانهٔ خشکی رسیده است',
  CROSSING_OUT_OF_HORIZON: 'عبور از آستانه در افق ۲۴ ساعت قابل برآورد نیست',
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function mad(values: number[]): number {
  const center = median(values);
  return median(values.map(value => Math.abs(value - center)));
}
function iqr(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return median(sorted.slice(sorted.length % 2 ? middle + 1 : middle)) - median(sorted.slice(0, middle));
}
function robustScale(values: number[]): number {
  const m = mad(values);
  return m > 0 ? 1.4826 * m : iqr(values) > 0 ? iqr(values) / 1.349 : 0;
}

function fit(points: Point[]): { slope: number; intercept: number; r2: number; residualMad: number } | null {
  const start = Date.parse(points[0].measuredAt!);
  const xs = points.map(point => (Date.parse(point.measuredAt!) - start) / 3600000);
  const ys = points.map(point => point.soilPercent!);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const xx = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  if (xx <= 0) return null;
  const slope = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0) / xx;
  const intercept = yMean - slope * xMean;
  const residuals = xs.map((x, index) => ys[index] - (intercept + slope * x));
  const sse = residuals.reduce((sum, r) => sum + r * r, 0);
  const sst = ys.reduce((sum, y) => sum + (y - yMean) ** 2, 0);
  if (sst <= 0) return { slope, intercept, r2: 0, residualMad: mad(residuals) };
  const r2 = Math.max(0, Math.min(1, 1 - sse / sst));
  return { slope, intercept, r2, residualMad: mad(residuals) };
}

function anomalies(points: Point[], pulses: Pulse[], discontinuities: string[], source: Source, runId: string | null): Anomaly[] {
  const output: Anomaly[] = [];
  if (points.length < 12) return output;
  const times = points.map(point => Date.parse(point.measuredAt!));
  const span = times[times.length - 1] - times[0];
  const values = points.map(point => point.soilPercent!);
  const add = (type: Anomaly['type'], start: Point, end: Point, observed: number, threshold: number) =>
    output.push({ type, severity: 'warning', evidenceStart: start.measuredAt!, evidenceEnd: end.measuredAt!,
      observed, threshold, pointIds: [start.id, end.id], source, runId, algorithmVersion });
  if (span >= 6 * 3600000 && Math.max(...values) - Math.min(...values) <= 0.5)
    add('STUCK_READING', points[0], points[points.length - 1], Math.max(...values) - Math.min(...values), 0.5);
  const changes: { start: Point; end: Point; delta: number; rate: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap <= 0 || gap > defaults.maxGapMs) continue;
    changes.push({ start: points[i - 1], end: points[i], delta: values[i] - values[i - 1],
      rate: (values[i] - values[i - 1]) / (gap / 3600000) });
  }
  if (changes.length) {
    const deltas = changes.map(change => change.delta);
    const rates = changes.map(change => change.rate);
    const deltaCenter = median(deltas), rateCenter = median(rates);
    const deltaLimit = Math.max(5, 3 * robustScale(deltas));
    const rateLimit = Math.max(2, 3 * robustScale(rates));
    for (const change of changes) {
      if (Math.abs(change.delta - deltaCenter) > deltaLimit &&
          !pulses.some(pulse => Date.parse(pulse.endedAt) >= Date.parse(change.start.measuredAt!) && Date.parse(pulse.endedAt) <= Date.parse(change.end.measuredAt!)) &&
          !discontinuities.some(at => Date.parse(at) >= Date.parse(change.start.measuredAt!) && Date.parse(at) <= Date.parse(change.end.measuredAt!)))
        add('UNEXPECTED_JUMP', change.start, change.end, change.delta, deltaLimit);
      if (change.rate < rateCenter - rateLimit && change.rate < -2)
        add('RAPID_DRYING', change.start, change.end, change.rate, rateCenter - rateLimit);
    }
  }
  for (const pulse of pulses) {
    const end = Date.parse(pulse.endedAt);
    const pre = points.filter(point => { const t = Date.parse(point.measuredAt!); return t >= end - 10 * 60000 && t < end; });
    const post = points.filter(point => { const t = Date.parse(point.measuredAt!); return t >= end + 10 * 60000 && t <= end + 30 * 60000; });
    if (pre.length < 12 || post.length < 12) continue;
    const rise = median(post.map(point => point.soilPercent!)) - median(pre.map(point => point.soilPercent!));
    if (rise < 2) add('WEAK_POST_WATERING_RESPONSE', pre[0], post[post.length - 1], rise, 2);
  }
  return output;
}

export function analyze(input: { deviceId: string; source: Source; runId: string | null;
  points: Point[]; pulses?: Pulse[]; discontinuities?: string[]; asOf?: string;
  sampleIntervalMs?: number; dryThresholdPercent?: number }): AnalysisResult {
  const interval = input.sampleIntervalMs ?? defaults.sampleIntervalMs;
  const threshold = input.dryThresholdPercent ?? defaults.dryThresholdPercent;
  if (!Number.isInteger(interval) || interval <= 0 || !Number.isFinite(threshold) || threshold < 0 || threshold > 100)
    throw new Error('Invalid analytics configuration');
  const configHash = sha(JSON.stringify({ ...defaults, sampleIntervalMs: interval, dryThresholdPercent: threshold }));
  const inputHash = sha(JSON.stringify(input.points.map(p => [p.id, p.measuredAt, p.soilPercent, p.calibrationRevision])));
  const idHex = sha(`${input.deviceId}:${input.runId ?? 'physical'}:${algorithmVersion}:${configHash}:${inputHash}`);
  const base = { id: `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-4${idHex.slice(13, 16)}-8${idHex.slice(17, 20)}-${idHex.slice(20, 32)}`,
    deviceId: input.deviceId, source: input.source, runId: input.runId, algorithmVersion, configHash, inputHash };
  const prediction = { crossingAt: null as string | null, slopePpPerHour: null as number | null,
    rSquared: null as number | null, residualMadPp: null as number | null, interceptPp: null as number | null,
    horizonMs: defaults.horizonMs, dryThresholdPercent: threshold };
  const fail = (status: ForecastStatus, reason: Reason, points: Point[], coverage: number | null,
    trend: AnalysisResult['trend'] = null, found: Anomaly[] = []): AnalysisResult => ({ ...base,
      trainingStart: points[0]?.measuredAt ?? null, trainingEnd: points.at(-1)?.measuredAt ?? null,
      sampleCount: points.length, coverage, status, reason, trend, prediction, anomalies: found,
      insightsFa: [`برای این بازه برآورد معتبر تولید نشد؛ ${reasonFa[reason] ?? 'شرط‌های اعتبار داده یا روند برقرار نیست'}.`],
    });
  if (input.points.some(p => p.deviceId !== input.deviceId || p.source !== input.source || p.runId !== input.runId))
    return fail('INSUFFICIENT_DATA', 'MIXED_PROVENANCE', [], null);
  const valid = input.points.filter(p => p.timeTrusted && p.measuredAt && Number.isFinite(Date.parse(p.measuredAt)) &&
    p.soilQuality === 'calibrated' && p.soilPercent !== null && Number.isFinite(p.soilPercent) && p.soilPercent >= 0 && p.soilPercent <= 100)
    .sort((a, b) => Date.parse(a.measuredAt!) - Date.parse(b.measuredAt!) || a.seq - b.seq);
  if (!valid.length) return fail('INSUFFICIENT_DATA', input.points.length ? 'TIME_UNTRUSTED' : 'TOO_FEW_SAMPLES', [], null);
  const asOf = Date.parse(input.asOf ?? valid.at(-1)!.measuredAt!);
  if (!Number.isFinite(asOf)) throw new Error('Invalid analysis time');
  const earliest = asOf - defaults.lookbackMs;
  const pulses = input.pulses ?? [];
  const found = anomalies(valid, pulses, input.discontinuities ?? [], input.source, input.runId);
  const lastPulse = Math.max(-Infinity,
    ...pulses.map(p => Date.parse(p.endedAt)).filter(Number.isFinite),
    ...(input.discontinuities ?? []).map(Date.parse).filter(Number.isFinite),
    ...found.filter(flag => flag.type === 'UNEXPECTED_JUMP').map(flag => Date.parse(flag.evidenceEnd)));
  const latestRevision = valid.at(-1)!.calibrationRevision;
  let latestRevisionStart = -1;
  for (let index = valid.length - 1; index >= 0; index--) {
    if (valid[index].calibrationRevision !== latestRevision) { latestRevisionStart = index; break; }
  }
  const filtered = valid.slice(latestRevisionStart + 1).filter(p => {
    const t = Date.parse(p.measuredAt!);
    return t >= earliest && t <= asOf && t > lastPulse;
  });
  const slots = new Map<number, Point>();
  if (filtered.length) {
    const start = Date.parse(filtered[0].measuredAt!);
    for (const point of filtered) {
      const slot = Math.round((Date.parse(point.measuredAt!) - start) / interval);
      if (!slots.has(slot)) slots.set(slot, point);
    }
  }
  const points = [...slots.values()].sort((a, b) => Date.parse(a.measuredAt!) - Date.parse(b.measuredAt!));
  const span = points.length > 1 ? Date.parse(points.at(-1)!.measuredAt!) - Date.parse(points[0].measuredAt!) : 0;
  const expected = Math.floor(span / interval) + 1;
  const coverage = points.length / expected;
  if (points.length < defaults.minSamples) return fail('INSUFFICIENT_DATA', 'TOO_FEW_SAMPLES', points, coverage, null, found);
  if (span < defaults.minSpanMs) return fail('INSUFFICIENT_DATA', 'TOO_SHORT_WINDOW', points, coverage, null, found);
  if (coverage < defaults.minCoverage) return fail('INSUFFICIENT_DATA', 'LOW_COVERAGE', points, coverage, null, found);
  if (points.some((p, i) => i > 0 && Date.parse(p.measuredAt!) - Date.parse(points[i - 1].measuredAt!) > defaults.maxGapMs))
    return fail('INSUFFICIENT_DATA', 'GAP_TOO_LARGE', points, coverage, null, found);
  if (asOf - Date.parse(points.at(-1)!.measuredAt!) > defaults.maxGapMs)
    return fail('INSUFFICIENT_DATA', 'GAP_TOO_LARGE', points, coverage, null, found);
  const ys = points.map(p => p.soilPercent!);
  const trend = { mean: ys.reduce((a, b) => a + b, 0) / ys.length,
    median: median(ys), observedRatePpPerHour: (ys.at(-1)! - ys[0]) / (span / 3600000) };
  const fitted = fit(points);
  if (!fitted) return fail('UNRELIABLE_TREND', 'ZERO_TIME_VARIANCE', points, coverage, trend, found);
  prediction.slopePpPerHour = fitted.slope;
  prediction.interceptPp = fitted.intercept;
  prediction.rSquared = fitted.r2;
  prediction.residualMadPp = fitted.residualMad;
  if (!Number.isFinite(fitted.slope) || !Number.isFinite(fitted.r2))
    return fail('UNRELIABLE_TREND', 'NONFINITE_INPUT', points, coverage, trend, found);
  if (ys.at(-1)! <= threshold) return fail('UNRELIABLE_TREND', 'ALREADY_DRY', points, coverage, trend, found);
  if (Math.abs(fitted.slope) < 0.01) return fail('UNRELIABLE_TREND', 'FLAT_TREND', points, coverage, trend, found);
  if (fitted.slope > 0) return fail('UNRELIABLE_TREND', 'INCREASING_TREND', points, coverage, trend, found);
  if (fitted.slope > defaults.minSlopePpPerHour) return fail('UNRELIABLE_TREND', 'FLAT_TREND', points, coverage, trend, found);
  if (fitted.r2 < defaults.minR2) return fail('UNRELIABLE_TREND', 'POOR_FIT', points, coverage, trend, found);
  if (fitted.residualMad > defaults.maxResidualMadPp) return fail('UNRELIABLE_TREND', 'NOISY_TREND', points, coverage, trend, found);
  const crossingHours = (threshold - fitted.intercept) / fitted.slope;
  const crossing = Date.parse(points[0].measuredAt!) + crossingHours * 3600000;
  if (!Number.isFinite(crossing) || crossing <= asOf || crossing - asOf > defaults.horizonMs)
    return fail('UNRELIABLE_TREND', 'CROSSING_OUT_OF_HORIZON', points, coverage, trend, found);
  prediction.crossingAt = new Date(crossing).toISOString();
  return { ...base, trainingStart: points[0].measuredAt!, trainingEnd: points.at(-1)!.measuredAt!,
    sampleCount: points.length, coverage, status: 'VALID', reason: null, trend, prediction,
    anomalies: found, insightsFa: ['رطوبت خاک در بازهٔ بررسی روند کاهشی داشته است.',
      'برآورد رسیدن به آستانهٔ خشکی بر پایهٔ داده‌های معتبر اخیر است.'] };
}
