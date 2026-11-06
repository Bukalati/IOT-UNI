import { createHash } from 'node:crypto';
import { analyze, algorithmVersion, median, type Point, type Source } from './index.js';

type Score = { eligible: number; candidateCount: number; baselineCount: number;
  candidateMae: number | null; baselineMae: number | null };
export type Evaluation = { status: 'VALID' | 'INSUFFICIENT_EVALUATION_DATA'; source: Source; runId: string | null;
  algorithmVersion: string; inputHash: string; eligibleOrigins: number; candidateValid: number;
  candidateAbstentions: number; baselineAbstentions: number; horizons: Record<'1h' | '3h', Score>;
  crossing: { observedCases: number; candidateCount: number; baselineCount: number;
    candidateMaeMinutes: number | null; baselineMaeMinutes: number | null } };

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function evaluate(input: { deviceId: string; source: Source; runId: string | null;
  points: Point[]; sampleIntervalMs?: number; dryThresholdPercent?: number }): Evaluation {
  const interval = input.sampleIntervalMs ?? 5000;
  const threshold = input.dryThresholdPercent ?? 30;
  const valid = input.points.filter(p => p.deviceId === input.deviceId && p.source === input.source && p.runId === input.runId &&
    p.timeTrusted && p.measuredAt && p.soilQuality === 'calibrated' && p.soilPercent !== null)
    .sort((a, b) => Date.parse(a.measuredAt!) - Date.parse(b.measuredAt!));
  const inputHash = createHash('sha256').update(JSON.stringify(valid.map(p => [p.id, p.measuredAt, p.soilPercent]))).digest('hex');
  const candidateErrors: Record<'1h' | '3h', number[]> = { '1h': [], '3h': [] };
  const baselineErrors: Record<'1h' | '3h', number[]> = { '1h': [], '3h': [] };
  const eligible: Record<'1h' | '3h', number> = { '1h': 0, '3h': 0 };
  const crossCandidate: number[] = [], crossBaseline: number[] = [];
  let crossingObserved = 0, eligibleOrigins = 0, candidateValid = 0, candidateAbstentions = 0, baselineAbstentions = 0;
  const base = () => ({ status: 'INSUFFICIENT_EVALUATION_DATA' as const, source: input.source, runId: input.runId,
    algorithmVersion, inputHash, eligibleOrigins, candidateValid, candidateAbstentions, baselineAbstentions,
    horizons: { '1h': { eligible: 0, candidateCount: 0, baselineCount: 0, candidateMae: null, baselineMae: null },
      '3h': { eligible: 0, candidateCount: 0, baselineCount: 0, candidateMae: null, baselineMae: null } },
    crossing: { observedCases: 0, candidateCount: 0, baselineCount: 0, candidateMaeMinutes: null, baselineMaeMinutes: null } });
  if (valid.length < 100 || !Number.isInteger(interval) || interval <= 0) return base();
  const split = Math.floor(valid.length * 0.8);
  const holdoutStart = Date.parse(valid[split].measuredAt!);
  const end = Date.parse(valid.at(-1)!.measuredAt!);
  if (end - holdoutStart < 2 * 3600000) return base();
  for (let origin = holdoutStart; origin < end; origin += 3600000) {
    const training = valid.filter(p => Date.parse(p.measuredAt!) <= origin);
    const future = valid.filter(p => Date.parse(p.measuredAt!) > origin);
    if (!future.length) continue;
    eligibleOrigins++;
    const analysis = analyze({ ...input, points: training, asOf: new Date(origin).toISOString(),
      sampleIntervalMs: interval, dryThresholdPercent: threshold });
    if (analysis.status === 'VALID') candidateValid++; else candidateAbstentions++;
    const recent = training.filter(p => Date.parse(p.measuredAt!) > origin - 10 * 60000);
    const previous = training.filter(p => Date.parse(p.measuredAt!) > origin - 20 * 60000 && Date.parse(p.measuredAt!) <= origin - 10 * 60000);
    const expected = Math.floor(10 * 60000 / interval);
    const baselineReady = recent.length >= expected * 0.8 && previous.length >= expected * 0.8;
    if (!baselineReady) baselineAbstentions++;
    const recentMedian = baselineReady ? median(recent.map(p => p.soilPercent!)) : null;
    const previousMedian = baselineReady ? median(previous.map(p => p.soilPercent!)) : null;
    const baselineRate = recentMedian !== null && previousMedian !== null ?
      (recentMedian - previousMedian) / (10 / 60) : null;
    const recentMidpoint = origin - 5 * 60000;
    for (const [label, horizon] of [['1h', 3600000], ['3h', 10800000]] as const) {
      const target = origin + horizon;
      const observed = future.filter(p => Math.abs(Date.parse(p.measuredAt!) - target) <= 5 * 60000)
        .sort((a, b) => Math.abs(Date.parse(a.measuredAt!) - target) - Math.abs(Date.parse(b.measuredAt!) - target))[0];
      if (!observed) continue;
      eligible[label]++;
      if (analysis.status === 'VALID' && analysis.prediction.interceptPp !== null && analysis.prediction.slopePpPerHour !== null) {
        const x = (target - Date.parse(analysis.trainingStart!)) / 3600000;
        candidateErrors[label].push(Math.abs(analysis.prediction.interceptPp + analysis.prediction.slopePpPerHour * x - observed.soilPercent!));
      }
      if (recentMedian !== null && baselineRate !== null)
        baselineErrors[label].push(Math.abs(recentMedian + baselineRate * ((target - recentMidpoint) / 3600000) - observed.soilPercent!));
    }
    const crossingIndex = future.findIndex(p => p.soilPercent! <= threshold && Date.parse(p.measuredAt!) - origin <= 86400000);
    if (crossingIndex < 0) continue;
    const firstCross = future[crossingIndex];
    const before = crossingIndex === 0 ? training.at(-1)! : future[crossingIndex - 1];
    if (before.soilPercent! <= threshold || before.soilPercent === firstCross.soilPercent) continue;
    crossingObserved++;
    const fraction = (before.soilPercent! - threshold) / (before.soilPercent! - firstCross.soilPercent!);
    const actual = Date.parse(before.measuredAt!) + fraction * (Date.parse(firstCross.measuredAt!) - Date.parse(before.measuredAt!));
    if (analysis.status === 'VALID' && analysis.prediction.crossingAt)
      crossCandidate.push(Math.abs(Date.parse(analysis.prediction.crossingAt) - actual) / 60000);
    if (recentMedian !== null && baselineRate !== null && baselineRate < 0)
      crossBaseline.push(Math.abs(recentMidpoint + (threshold - recentMedian) / baselineRate * 3600000 - actual) / 60000);
  }
  return { status: 'VALID', source: input.source, runId: input.runId, algorithmVersion, inputHash,
    eligibleOrigins, candidateValid, candidateAbstentions, baselineAbstentions,
    horizons: { '1h': { eligible: eligible['1h'], candidateCount: candidateErrors['1h'].length,
      baselineCount: baselineErrors['1h'].length, candidateMae: mean(candidateErrors['1h']), baselineMae: mean(baselineErrors['1h']) },
    '3h': { eligible: eligible['3h'], candidateCount: candidateErrors['3h'].length,
      baselineCount: baselineErrors['3h'].length, candidateMae: mean(candidateErrors['3h']), baselineMae: mean(baselineErrors['3h']) } },
    crossing: { observedCases: crossingObserved, candidateCount: crossCandidate.length,
      baselineCount: crossBaseline.length, candidateMaeMinutes: mean(crossCandidate), baselineMaeMinutes: mean(crossBaseline) } };
}
