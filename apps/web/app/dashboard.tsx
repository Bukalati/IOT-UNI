'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const api = process.env.NEXT_PUBLIC_API_URL ?? '/backend';
type Status = { availability: 'online' | 'offline' | 'stale'; bootId: string | null; lastLiveAt: string | null };
type Device = { id: string; identity_kind: 'physical' | 'simulator'; display_name: string; status: Status };
type Latest = { received_at: string; measured_at: string | null; soil_percent: number | null; soil_quality: string;
  tank_percent: number | null; tank_quality: string; pump_on: number; mode: string; state: string;
  source: string; simulation_run_id: string | null };
type Detail = { device: Device; status: Status; latest: Latest | null; hardwareCommissioned: boolean;
  desired: { revision: number; status: string } | null; reported: { revision: number } | null };
type Point = { measured_at: string | null; received_at: string; soil_percent: number | null;
  soil_quality: string; source: string; simulation_run_id: string | null; seq: number };
type Command = { id: string; status: string; reason_code: string | null };
type SimRun = { id: string; scenario: string; seed: number; canonical_hash: string };
type Alert = { id: number; code: string; severity: string; opened_at: string; resolved_at: string | null; details: Record<string, unknown> };
type Calibration = { kind: string; revision: number; endpoint_a: number | null; endpoint_b: number | null; status: string; reported_at: string };
type Analysis = { status: 'VALID' | 'INSUFFICIENT_DATA' | 'UNRELIABLE_TREND'; reason: string | null;
  algorithmVersion: string; source: string; runId: string | null; sampleCount: number; coverage: number | null;
  trainingStart: string | null; trainingEnd: string | null; prediction: { crossingAt: string | null; slopePpPerHour: number | null };
  anomalies: { type: string }[]; insightsFa: string[] };

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, { credentials: 'include', cache: 'no-store', ...init });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).code ?? `HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
const date = (value: string | null) => value ? new Intl.DateTimeFormat('fa-IR', {
  dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Tehran',
}).format(new Date(value)) : 'نامشخص';
const percent = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value}٪`;

function Trend({ points }: { points: Point[] }) {
  const valid = points.filter(p => p.measured_at && p.soil_percent !== null && p.soil_quality === 'calibrated');
  if (valid.length < 2) return <p className="empty">دادهٔ معتبر کافی برای نمودار وجود ندارد.</p>;
  const width = 760, height = 190, pad = 20;
  const first = Date.parse(valid[0].measured_at!);
  const span = Math.max(1, Date.parse(valid[valid.length - 1].measured_at!) - first);
  const segments: Point[][] = [];
  let segment: Point[] = [];
  let previous: Point | null = null;
  for (const point of valid) {
    if (previous && Date.parse(point.measured_at!) - Date.parse(previous.measured_at!) > 15000) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    segment.push(point);
    previous = point;
  }
  if (segment.length) segments.push(segment);
  const paths = segments.map(group => group.filter((_, index) => index % 5 === 0 || index === group.length - 1)
    .map((point, index) => {
      const x = pad + (Date.parse(point.measured_at!) - first) / span * (width - 2 * pad);
      const y = height - pad - point.soil_percent! / 100 * (height - 2 * pad);
      return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' '));
  return <div className="chart"><svg viewBox={`0 0 ${width} ${height}`} role="img"
    aria-label="روند رطوبت خاک؛ فاصله‌های بدون داده رسم نشده‌اند">
    {[0, 25, 50, 75, 100].map(value => <g key={value}><line x1={pad} x2={width - pad}
      y1={height - pad - value / 100 * (height - 2 * pad)} y2={height - pad - value / 100 * (height - 2 * pad)} />
      <text x={width - 2} y={height - pad - value / 100 * (height - 2 * pad) + 4} textAnchor="end">{value}٪</text></g>)}
    {paths.map((part, index) => <path key={index} d={part} fill="none" stroke="#2f7952" strokeWidth="3" />)}
  </svg><p>رطوبت خاک · شکاف‌ها به معنی نمونهٔ ثبت‌نشده‌اند.</p></div>;
}

export default function Dashboard() {
  const [password, setPassword] = useState('');
  const [csrf, setCsrf] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [runs, setRuns] = useState<SimRun[]>([]);
  const [selected, setSelected] = useState('plant-01');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [history, setHistory] = useState<Point[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [commandId, setCommandId] = useState<string | null>(null);
  const [command, setCommand] = useState<Command | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const [list, simulations] = await Promise.all([
        readJson<{ devices: Device[] }>('/api/devices'), readJson<{ runs: SimRun[] }>('/api/simulations'),
      ]);
      setDevices(list.devices);
      setRuns(simulations.runs);
      const id = list.devices.some(d => d.id === selected) ? selected : list.devices[0]?.id;
      if (!id) return;
      if (id !== selected) setSelected(id);
      const simulation = list.devices.find(d => d.id === id)?.identity_kind === 'simulator';
      const runId = simulation ? (selectedRun ?? simulations.runs.find(r => r.scenario === 'gradual-drying')?.id ?? simulations.runs[0]?.id) : null;
      if (simulation && runId && runId !== selectedRun) setSelectedRun(runId);
      const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
      const [nextDetail, nextHistory, nextAnalysis, nextAlerts, nextCalibrations] = await Promise.all([
        readJson<Detail>(`/api/devices/${encodeURIComponent(id)}${query}`),
        readJson<{ rows: Point[] }>(`/api/devices/${encodeURIComponent(id)}/history?limit=500${runId ? `&runId=${encodeURIComponent(runId)}` : ''}`),
        readJson<Analysis>(`/api/devices/${encodeURIComponent(id)}/analysis${query}`),
        readJson<{ alerts: Alert[] }>(`/api/devices/${encodeURIComponent(id)}/alerts?limit=50`),
        readJson<{ calibrations: Calibration[] }>(`/api/devices/${encodeURIComponent(id)}/calibrations`),
      ]);
      setDetail(nextDetail);
      setHistory(nextHistory.rows);
      setAnalysis(nextAnalysis);
      setAlerts(nextAlerts.alerts);
      setCalibrations(nextCalibrations.calibrations);
      if (commandId) setCommand(await readJson<Command>(`/api/commands/${encodeURIComponent(commandId)}`));
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'خطای دریافت داده'); }
  }, [selected, selectedRun, commandId]);

  useEffect(() => { void readJson<{ csrfToken: string }>('/auth/session')
    .then(result => setCsrf(result.csrfToken)).catch(() => undefined); }, []);
  useEffect(() => { if (csrf) void refresh(); }, [csrf, refresh]);
  useEffect(() => {
    if (!csrf) return;
    const stream = new EventSource(`${api}/api/events`, { withCredentials: true });
    stream.addEventListener('update', () => { void refresh(); });
    stream.addEventListener('snapshot', () => { void refresh(); });
    return () => stream.close();
  }, [csrf, refresh]);
  useEffect(() => { const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const status = useMemo(() => {
    if (!detail) return null;
    if (detail.status.availability === 'online' && detail.status.lastLiveAt && tick - Date.parse(detail.status.lastLiveAt) >= 30000)
      return 'stale';
    return detail.status.availability;
  }, [detail, tick]);
  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await readJson<{ csrfToken: string }>('/auth/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      setCsrf(result.csrfToken); setPassword('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ورود ناموفق بود'); }
    finally { setBusy(false); }
  }
  async function requestPulse() {
    if (!csrf) return;
    setBusy(true); setError('');
    try {
      const result = await readJson<{ commandId: string }>(`/api/devices/${encodeURIComponent(selected)}/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ durationMs: 2000 }),
      });
      setCommandId(result.commandId);
      setCommand({ id: result.commandId, status: 'queued', reason_code: null });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'فرمان ثبت نشد'); }
    finally { setBusy(false); }
  }
  return <>
    <header className="topbar"><div><p className="eyebrow">SMART IRRIGATION · LOCAL LAB</p><h1>آبیاری هوشمند</h1>
      <p>وضعیت گیاه با تفکیک دادهٔ واقعی و شبیه‌سازی</p></div>
      {csrf && <button className="ghost" onClick={() => void refresh()}>به‌روزرسانی</button>}</header>
    {!csrf ? <section className="card login"><h2>ورود اپراتور</h2><p>برای دیدن داده‌ها وارد شوید.</p>
      <form onSubmit={event => void login(event)}><label htmlFor="password">رمز عبور</label>
        <input id="password" type="password" value={password} onChange={event => setPassword(event.target.value)} required autoComplete="current-password" />
        <button className="primary" disabled={busy}>ورود</button></form></section>
    : <><div className="selector"><label htmlFor="device">منبع داده</label><select id="device" value={selected}
      onChange={event => { setSelected(event.target.value); setDetail(null); setHistory([]); setAnalysis(null); setCommandId(null); setCommand(null); }}>
      {devices.map(device => <option key={device.id} value={device.id}>{device.display_name} · {device.identity_kind === 'physical' ? 'واقعی' : 'شبیه‌سازی'}</option>)}
    </select><span className={`status status-${status ?? 'stale'}`}>{status === 'online' ? 'متصل' : status === 'offline' ? 'قطع' : 'قدیمی / نامشخص'}</span></div>
    {detail?.device.identity_kind === 'simulator' && <div className="selector"><label htmlFor="run">سناریوی شبیه‌سازی</label>
      <select id="run" value={selectedRun ?? ''} onChange={event => { setSelectedRun(event.target.value); setDetail(null); setHistory([]); setAnalysis(null); }}>
        {runs.map(run => <option key={run.id} value={run.id}>{run.scenario} · seed {run.seed}</option>)}
      </select></div>}
    <div className="metrics"><section className="card metric"><span>رطوبت خاک</span><strong>{percent(detail?.latest?.soil_percent)}</strong><small>کیفیت: {detail?.latest?.soil_quality ?? 'نامشخص'}</small></section>
      <section className="card metric"><span>سطح تقریبی مخزن</span><strong>{percent(detail?.latest?.tank_percent)}</strong><small>کیفیت: {detail?.latest?.tank_quality ?? 'نامشخص'}</small></section>
      <section className="card metric"><span>پمپ / وضعیت</span><strong>{detail?.latest ? (detail.latest.pump_on ? 'فرمان روشن' : 'خاموش') : '—'}</strong><small>{detail?.latest?.state ?? 'بدون داده'}</small></section></div>
    <div className="grid"><section className="card"><div className="section-head"><h2>روند رطوبت</h2><span>{history.length} نمونه</span></div><Trend points={history} />
      <div className="time-row"><span>زمان اندازه‌گیری: {date(detail?.latest?.measured_at ?? null)}</span><span>دریافت در سرور: {date(detail?.latest?.received_at ?? null)}</span></div>
      <p className="source-note">{detail?.device.identity_kind === 'simulator' ? `شبیه‌سازی · ${detail.latest?.simulation_run_id ?? 'اجرای نامشخص'}` : 'دادهٔ واقعی؛ وضعیت پمپ فقط فرمان خروجی را نشان می‌دهد.'}</p></section>
      <section className="card"><h2>فرمان و تنظیمات</h2><p>حالت گزارش‌شده: <b>{detail?.latest?.mode ?? 'نامشخص'}</b></p>
        <p>نسخهٔ تنظیمات اعمال‌شده: <b>{detail?.reported?.revision ?? '—'}</b></p>
        <p>نسخهٔ درخواستی: <b>{detail?.desired?.revision ?? '—'}</b> {detail?.desired?.status ? `(${detail.desired.status})` : ''}</p>
        <button className="primary" disabled={busy || !detail?.hardwareCommissioned || status !== 'online' || detail.device.identity_kind !== 'physical'}
          onClick={() => void requestPulse()}>درخواست پالس ۲ ثانیه‌ای</button>
        {!detail?.hardwareCommissioned && <p className="notice">فرمان فیزیکی تا تأیید تست‌های سخت‌افزار بسته است.</p>}
        {command && <p className="notice">فرمان {command.id.slice(0, 8)}: {command.status} {command.reason_code ?? ''}</p>}</section></div>
    <section className="card table-card"><div className="section-head"><h2>تحلیل مشورتی گیاه</h2><span>{analysis?.algorithmVersion ? `نسخه ${analysis.algorithmVersion}` : 'بدون تحلیل'}</span></div>
      <p className="advisory">{analysis?.status === 'VALID' ? `برآورد رسیدن به آستانهٔ خشکی: ${date(analysis.prediction.crossingAt)}`
        : analysis?.insightsFa[0] ?? 'دادهٔ کافی برای برآورد در دسترس نیست.'}</p>
      {analysis?.status === 'VALID' && analysis.insightsFa.map((insight, index) => <p key={index}>{insight}</p>)}
      {analysis?.anomalies.length ? <p>نامزدهای ناهنجاری: {analysis.anomalies.map(item => item.type).join('، ')}؛ تشخیص خرابی نیستند.</p> : null}
      <p className="source-note">{analysis?.source === 'simulator' ? `شبیه‌سازی · ${analysis.runId}` : 'دادهٔ واقعی'} · {analysis?.sampleCount ?? 0} نمونه · پوشش {analysis?.coverage === null || analysis?.coverage === undefined ? 'نامشخص' : `${Math.round(analysis.coverage * 100)}٪`} · بازه {date(analysis?.trainingStart ?? null)} تا {date(analysis?.trainingEnd ?? null)}</p>
    </section>
    <section className="card table-card"><h2>آخرین اندازه‌گیری‌ها</h2><div className="table-scroll"><table><thead><tr><th>زمان اندازه‌گیری</th><th>رطوبت</th><th>کیفیت</th><th>منبع</th></tr></thead>
      <tbody>{history.slice(-10).reverse().map(point => <tr key={`${point.simulation_run_id ?? 'device'}-${point.seq}`}>
        <td>{date(point.measured_at)}</td><td>{percent(point.soil_percent)}</td><td>{point.soil_quality}</td>
        <td>{point.source === 'simulator' ? 'شبیه‌سازی' : 'واقعی'}</td></tr>)}</tbody></table>
      {history.length === 0 && <p className="empty">هنوز اندازه‌گیری ثبت نشده است.</p>}</div></section></>}
    {csrf && <div className="grid table-card"><section className="card" aria-labelledby="alerts-title"><h2 id="alerts-title">هشدارهای فعال</h2>
      {alerts.length ? <ul className="list">{alerts.map(alert => <li key={alert.id}><b>{alert.code}</b> · {alert.severity} · {date(alert.opened_at)}</li>)}</ul>
        : <p className="empty">هشدار فعالی ثبت نشده است.</p>}</section>
      <section className="card" aria-labelledby="calibration-title"><h2 id="calibration-title">وضعیت کالیبراسیون</h2>
        {calibrations.length ? <ul className="list">{calibrations.map(item => <li key={item.kind}>
          <b>{item.kind === 'soil' ? 'رطوبت خاک' : 'مخزن'}</b> · {item.status} · نسخه {item.revision}
          {item.endpoint_a !== null && item.endpoint_b !== null ? ` · ${item.endpoint_a} / ${item.endpoint_b}` : ''}
        </li>)}</ul> : <p className="empty">هنوز کالیبراسیون دستگاه گزارش نشده است.</p>}
        <p className="notice">کالیبراسیون از این صفحه قابل تغییر نیست؛ باید روی دستگاه اندازه‌گیری و گزارش شود.</p>
      </section></div>}
    {error && <div className="error" role="alert">{error}</div>}
  </>;
}
