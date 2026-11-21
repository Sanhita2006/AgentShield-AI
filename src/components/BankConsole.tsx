import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface ConsoleOverview {
  kpis: {
    actionsToday: number;
    totalAnalyzed: number;
    blockedCount: number;
    escalatedCount: number;
    falseAlertRate: string;
    avgLatencyMs: number;
    disputeResolutionTime: string;
  };
  feed: Array<{
    id: string;
    request_id: string;
    agent_id: string;
    agent_name: string;
    action: string;
    payee_name: string | null;
    amount: number;
    verdict: 'ALLOW' | 'ASK_CUSTOMER' | 'BLOCK';
    risk_score: number;
    reasons: string[];
    technical_reasons: string[];
    latency_ms: number;
    created_at: number;
  }>;
  riskOverTime: Array<{ index: number; time: string; riskScore: number; verdict: string; agent: string }>;
  blocksByThreat: Array<{ threat: string; count: number }>;
  agents: Array<{
    id: string;
    name: string;
    publisher: string;
    description: string;
    public_key: string;
    status: 'active' | 'suspended' | 'quarantined';
    risk_tier: string;
  }>;
  alerts: Array<{ id: string; severity: string; title: string; message: string; created_at: number }>;
  settings: Record<string, string>;
}

interface SelfTestSummary {
  attackScenariosStopped: number;
  attackScenariosTotal: number;
  passed: number;
  total: number;
  avgLatencyMs: number;
}

interface BenchmarkSummaryView {
  disclaimer: string;
  generatedAt: string;
  datasetCounts: { total: number; attacks: number; benign: number };
  rulesOnly: {
    attacksStopped: number;
    attackSamples: number;
    attackDetectionRatePct: number;
    stage2ContainedCount: number;
    uncontainedMissCount: number;
    benignSamples: number;
    benignBlocked: number;
    benignEscalated: number;
    benignHardFalsePositiveRatePct: number;
    latencyMs: { p50: number; p95: number; p99: number };
    missedAttacks: Array<{ id: string; category: string; stage2Contained: boolean; description: string }>;
  };
  judgeComparisonNote: string;
}

interface BankConsoleProps {
  sseTick: number;
  onToast: (msg: string, tone?: 'info' | 'warn' | 'error' | 'success') => void;
}

export function BankConsole({ sseTick, onToast }: BankConsoleProps) {
  const [data, setData] = useState<ConsoleOverview | null>(null);
  const [selfTest, setSelfTest] = useState<SelfTestSummary | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkSummaryView | null>(null);
  const [allowMax, setAllowMax] = useState(39);
  const [askMax, setAskMax] = useState(69);
  const [selectedFeedId, setSelectedFeedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Keep the latest onToast in a ref so loadConsole stays stable (App recreates pushToast every render).
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const authToastShownRef = useRef(false);

  const loadConsole = useCallback(async (signal?: AbortSignal) => {
    try {
      const resp = await fetch('/api/console/overview', { signal });
      if (resp.ok) {
        const json = (await resp.json()) as ConsoleOverview;
        setData(json);
        setLoadError(null);
        authToastShownRef.current = false;
        setAllowMax(Number(json.settings.allow_max_score ?? 39));
        setAskMax(Number(json.settings.ask_max_score ?? 69));
      } else if (resp.status === 401 || resp.status === 403) {
        setData(null);
        setLoadError('Bank Admin sign-in required to view the console. Use "Bank Admin" in the top toolbar.');
        if (!authToastShownRef.current) {
          authToastShownRef.current = true;
          onToastRef.current('Bank Admin sign-in required to view the console.', 'warn');
        }
      } else {
        setLoadError('Unable to load Bank Console overview.');
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setLoadError('Network error while connecting to Bank Console API.');
    }
  }, []);

  const runSelfTest = useCallback(async (signal?: AbortSignal) => {
    try {
      const [stResp, bmResp] = await Promise.all([
        fetch('/api/selftest', { signal }),
        fetch('/api/benchmark', { signal }),
      ]);
      if (stResp.ok) {
        const json = (await stResp.json()) as SelfTestSummary;
        setSelfTest(json);
      }
      if (bmResp.ok) {
        const bmJson = (await bmResp.json()) as BenchmarkSummaryView;
        setBenchmark(bmJson);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      // Ignore transient network errors during navigation or server reload
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadConsole(controller.signal);
    return () => controller.abort();
  }, [loadConsole, sseTick]);

  useEffect(() => {
    const controller = new AbortController();
    void runSelfTest(controller.signal);
    return () => controller.abort();
  }, [runSelfTest]);

  const handleAgentStatus = async (agentId: string, status: 'active' | 'suspended' | 'quarantined') => {
    try {
      const resp = await fetch(`/api/console/agents/${agentId}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (resp.ok) {
        onToast(`Agent ${agentId} status set to ${status}.`, status === 'active' ? 'success' : 'warn');
        void loadConsole();
      } else {
        onToast('Failed to update agent status.', 'error');
      }
    } catch {
      onToast('Network error updating agent status.', 'error');
    }
  };

  const handleSaveThresholds = async () => {
    try {
      const resp = await fetch('/api/console/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allow_max_score: allowMax, ask_max_score: askMax }),
      });
      if (resp.ok) {
        onToast(`Risk thresholds updated: 0-${allowMax} ALLOW, ${allowMax + 1}-${askMax} ASK, ${askMax + 1}-100 BLOCK`, 'success');
        void loadConsole();
      } else {
        const err = (await resp.json()) as { error?: string };
        onToast(err.error || 'Failed to update thresholds', 'error');
      }
    } catch {
      onToast('Network error updating thresholds.', 'error');
    }
  };

  if (!data) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-12">
        {loadError ? (
          <div className="rounded-2xl border border-amber-500/40 bg-black/75 p-6 text-center space-y-3">
            <p className="text-sm text-amber-300 font-medium">{loadError}</p>
            <button
              type="button"
              onClick={() => void loadConsole()}
              className="px-4 py-2 text-xs font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors"
            >
              Retry Connection
            </button>
          </div>
        ) : (
          <div className="h-80 rounded-2xl bg-slate-200 dark:bg-slate-900 animate-pulse" />
        )}
      </div>
    );
  }

  const latestRisk = data.feed[0]?.risk_score ?? 12;
  const gaugeAngle = -90 + (latestRisk / 100) * 180;
  const selectedRow = data.feed.find((f) => f.id === selectedFeedId) ?? data.feed[0];

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
      {/* Header + Real-Time Self-Test Proof Badge */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-orange-500">Bank Security Operations Console · Live SSE Stream</p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mt-1">
            Gateway Telemetry & Policy Enforcement
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="px-4 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 text-xs font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span className="font-mono">
              {selfTest
                ? `${selfTest.attackScenariosStopped}/${selfTest.attackScenariosTotal} attack scenarios stopped`
                : 'Verifying scenarios...'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void runSelfTest()}
            className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Run /api/selftest</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: 'Actions Today', value: data.kpis.actionsToday, tone: 'text-slate-900 dark:text-white' },
          { label: 'Blocked Attacks', value: data.kpis.blockedCount, tone: 'text-rose-500' },
          { label: 'Escalated', value: data.kpis.escalatedCount, tone: 'text-amber-500' },
          { label: 'False-Alert Rate', value: data.kpis.falseAlertRate, tone: 'text-sky-500' },
          { label: 'Avg Decision Latency', value: `${data.kpis.avgLatencyMs} ms`, tone: 'text-emerald-500' },
          { label: 'Dispute Resolution', value: data.kpis.disputeResolutionTime, tone: 'text-slate-900 dark:text-white' },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-xl border border-white/14 bg-black/84 p-4"
          >
            <div className="text-xs text-slate-500 dark:text-slate-400">{kpi.label}</div>
            <div className={`font-mono text-2xl font-bold tabular-nums mt-1 ${kpi.tone}`}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* Charts + Animated Risk Gauge */}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 rounded-2xl border border-white/14 bg-black/84 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">Risk Score Over Time</h2>
            <span className="font-mono text-xs text-slate-500">Bands: 0-{allowMax} / {askMax + 1}-100</span>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.riskOverTime}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.35} />
                <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#f8fafc', fontSize: 12 }}
                />
                <ReferenceLine y={allowMax} stroke="#10b981" strokeDasharray="4 4" />
                <ReferenceLine y={askMax} stroke="#f43f5e" strokeDasharray="4 4" />
                <Area type="monotone" dataKey="riskScore" stroke="#f97316" fill="#f97316" fillOpacity={0.22} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-4 rounded-2xl border border-white/14 bg-black/84 p-6">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white mb-4">Blocks by Threat Type</h2>
          <div className="h-56">
            {data.blocksByThreat.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.blocksByThreat} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.35} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                  <YAxis type="category" dataKey="threat" width={115} tick={{ fontSize: 10, fill: '#cbd5e1' }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', color: '#f8fafc', fontSize: 12 }}
                  />
                  <Bar dataKey="count" fill="#f97316" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                Run scenarios in Attack Lab to populate threat breakdown.
              </div>
            )}
          </div>
        </div>

        {/* Animated Risk Gauge + Threshold Tuning */}
        <div className="lg:col-span-3 rounded-2xl border border-white/14 bg-black/84 p-6 flex flex-col justify-between">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white mb-2">Latest Risk Gauge</h2>
            <div className="flex flex-col items-center py-2">
              <svg viewBox="0 0 200 115" className="w-44 h-28">
                <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#1e293b" strokeWidth="14" strokeLinecap="round" />
                <path d="M 20 100 A 80 80 0 0 1 85 22" fill="none" stroke="#10b981" strokeWidth="14" strokeLinecap="round" />
                <path d="M 88 22 A 80 80 0 0 1 142 32" fill="none" stroke="#f59e0b" strokeWidth="14" strokeLinecap="round" />
                <path d="M 145 34 A 80 80 0 0 1 180 100" fill="none" stroke="#f43f5e" strokeWidth="14" strokeLinecap="round" />
                <g transform={`translate(100,100) rotate(${gaugeAngle})`} className="transition-transform duration-500">
                  <line x1="0" y1="0" x2="0" y2="-66" stroke="#f97316" strokeWidth="3.5" strokeLinecap="round" />
                  <circle cx="0" cy="0" r="6" fill="#f97316" />
                </g>
              </svg>
              <div className="font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums -mt-2">
                {latestRisk}/100
              </div>
              <div className="text-xs text-slate-500">{data.feed[0]?.verdict || 'NOMINAL'}</div>
            </div>
          </div>

          <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
              <Sliders className="w-3.5 h-3.5 text-orange-500" />
              <span>Risk Band Thresholds</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              0–{allowMax}: Auto-Allow · {allowMax + 1}–{askMax}: Ask Customer · {askMax + 1}–100: Auto-Block
            </p>
            <div>
              <div className="flex justify-between text-[11px] text-slate-500 font-mono">
                <span>ALLOW Max</span>
                <span>{allowMax}</span>
              </div>
              <input
                type="range"
                min={15}
                max={55}
                value={allowMax}
                onChange={(e) => setAllowMax(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>
            <div>
              <div className="flex justify-between text-[11px] text-slate-500 font-mono">
                <span>ASK_CUSTOMER Max</span>
                <span>{askMax}</span>
              </div>
              <input
                type="range"
                min={50}
                max={90}
                value={askMax}
                onChange={(e) => setAskMax(Number(e.target.value))}
                className="w-full accent-orange-500"
              />
            </div>
            <button
              type="button"
              onClick={handleSaveThresholds}
              className="w-full py-1.5 text-xs font-semibold bg-slate-900 dark:bg-orange-500 hover:opacity-90 text-white rounded-lg transition-opacity"
            >
              Save Thresholds
            </button>
          </div>
        </div>
      </div>

      {/* Live Action Feed + Selected Decision Technical Detail */}
      <div className="grid lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 rounded-2xl border border-white/14 bg-black/84 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-orange-500" />
              <span>Live Gateway Decision Feed</span>
            </h2>
            <span className="font-mono text-xs text-slate-500">Click row for technical trace</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="pb-2 font-medium">Verdict</th>
                  <th className="pb-2 font-medium">Agent</th>
                  <th className="pb-2 font-medium">Action / Payee</th>
                  <th className="pb-2 font-medium text-right">Amount</th>
                  <th className="pb-2 font-medium text-right">Score</th>
                  <th className="pb-2 font-medium text-right">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
                {data.feed.slice(0, 14).map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedFeedId(row.id)}
                    className={`cursor-pointer transition-colors ${
                      selectedRow?.id === row.id
                        ? 'bg-orange-500/10'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-900/60'
                    }`}
                  >
                    <td className="py-2.5 pr-2">
                      <span
                        className={`font-mono font-bold ${
                          row.verdict === 'ALLOW'
                            ? 'text-emerald-500'
                            : row.verdict === 'ASK_CUSTOMER'
                            ? 'text-amber-500'
                            : 'text-rose-500'
                        }`}
                      >
                        {row.verdict}
                      </span>
                    </td>
                    <td className="py-2.5 pr-2 font-medium text-slate-900 dark:text-slate-100">{row.agent_name}</td>
                    <td className="py-2.5 pr-2 text-slate-600 dark:text-slate-400">
                      {row.action} · {row.payee_name || '—'}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {row.amount > 0 ? `₹${row.amount.toLocaleString('en-IN')}` : '—'}
                    </td>
                    <td className="py-2.5 text-right font-mono tabular-nums">{row.risk_score}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-slate-500">{row.latency_ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Technical Inspector + Agent Registry + Alerts */}
        <div className="lg:col-span-5 space-y-6">
          {selectedRow && (
            <div className="rounded-2xl border border-white/14 bg-black/84 p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  Explainable Decision Trace
                </h3>
                <span className="font-mono text-xs text-slate-500">{selectedRow.request_id}</span>
              </div>
              <div className="space-y-2 text-xs">
                <div className="text-slate-600 dark:text-slate-300">
                  <span className="font-semibold text-slate-900 dark:text-white">Customer View:</span>{' '}
                  {selectedRow.reasons.join(' ')}
                </div>
                <div className="rounded-lg bg-slate-100 dark:bg-slate-900 p-3 font-mono text-[11px] text-slate-700 dark:text-slate-300 space-y-1">
                  {selectedRow.technical_reasons.map((tr, i) => (
                    <div key={i}>{tr}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Agent Registry with Suspend / Quarantine */}
          <div className="rounded-2xl border border-white/14 bg-black/84 p-6">
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-4">
              <ShieldCheck className="w-4 h-4 text-orange-500" />
              <span>Agent Registry & Quarantine</span>
            </h3>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.agents.map((ag) => (
                <div key={ag.id} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white">{ag.name}</div>
                    <div className="text-xs text-slate-500">
                      {ag.publisher} · <span className="font-mono">{ag.status.toUpperCase()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleAgentStatus(ag.id, 'active')}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md ${
                        ag.status === 'active'
                          ? 'bg-emerald-600 text-white'
                          : 'border border-slate-300 dark:border-slate-700 text-slate-500'
                      }`}
                    >
                      Active
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAgentStatus(ag.id, 'quarantined')}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md ${
                        ag.status === 'quarantined'
                          ? 'bg-amber-600 text-white'
                          : 'border border-slate-300 dark:border-slate-700 text-slate-500'
                      }`}
                    >
                      Quarantine
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAgentStatus(ag.id, 'suspended')}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md ${
                        ag.status === 'suspended'
                          ? 'bg-rose-600 text-white'
                          : 'border border-slate-300 dark:border-slate-700 text-slate-500'
                      }`}
                    >
                      Suspend
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Alerts Panel */}
          <div className="rounded-2xl border border-white/14 bg-black/84 p-6">
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-3">
              <ShieldAlert className="w-4 h-4 text-rose-500" />
              <span>Security Alerts ({data.alerts.length})</span>
            </h3>
            {data.alerts.length === 0 ? (
              <div className="text-xs text-slate-500 flex items-center gap-2">
                <AlertOctagon className="w-4 h-4 text-slate-400" />
                <span>No critical security incidents logged yet.</span>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-48 overflow-y-auto">
                {data.alerts.map((al) => (
                  <div key={al.id} className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs">
                    <div className="font-semibold text-rose-500">{al.title}</div>
                    <div className="text-slate-600 dark:text-slate-300 mt-0.5">{al.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Red-Team Benchmark Summary */}
      {benchmark && (
        <div className="rounded-2xl border border-white/14 bg-black/84 p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-4">
            <div>
              <h2 className="font-display text-base font-bold text-white">
                Pipeline Evaluation Benchmark ({benchmark.datasetCounts.total} Samples)
              </h2>
              <p className="text-xs text-amber-400 mt-0.5">
                Our red-team set, not an independent audit · {benchmark.judgeComparisonNote}
              </p>
            </div>
            <span className="font-mono text-[11px] text-slate-400">
              {benchmark.datasetCounts.attacks} attack · {benchmark.datasetCounts.benign} benign
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Attacks Stopped</div>
              <div className="font-mono text-lg font-bold text-emerald-400 tabular-nums mt-0.5">
                {benchmark.rulesOnly.attacksStopped}/{benchmark.rulesOnly.attackSamples} ({benchmark.rulesOnly.attackDetectionRatePct}%)
              </div>
            </div>
            <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Stage 2 Contained Misses</div>
              <div className="font-mono text-lg font-bold text-amber-400 tabular-nums mt-0.5">
                {benchmark.rulesOnly.stage2ContainedCount} (damage-limited)
              </div>
            </div>
            <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Uncontained Misses</div>
              <div className="font-mono text-lg font-bold text-rose-400 tabular-nums mt-0.5">
                {benchmark.rulesOnly.uncontainedMissCount}
              </div>
            </div>
            <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Benign Hard FP Rate</div>
              <div className="font-mono text-lg font-bold text-sky-400 tabular-nums mt-0.5">
                {benchmark.rulesOnly.benignHardFalsePositiveRatePct}% ({benchmark.rulesOnly.benignBlocked}/{benchmark.rulesOnly.benignSamples})
              </div>
            </div>
            <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3">
              <div className="text-[11px] text-slate-400">Latency (p50 / p95 / p99)</div>
              <div className="font-mono text-sm font-bold text-white tabular-nums mt-1">
                {benchmark.rulesOnly.latencyMs.p50} / {benchmark.rulesOnly.latencyMs.p95} / {benchmark.rulesOnly.latencyMs.p99} ms
              </div>
            </div>
          </div>

          {benchmark.rulesOnly.missedAttacks.length > 0 && (
            <div className="text-xs text-slate-400">
              <span className="font-semibold text-slate-200">Honestly reported Stage-3 misses ({benchmark.rulesOnly.missedAttacks.length}):</span>{' '}
              {benchmark.rulesOnly.missedAttacks.slice(0, 4).map((m) => `${m.id} (${m.stage2Contained ? 'capped by Stage 2' : 'uncapped'})`).join(', ')}
              {benchmark.rulesOnly.missedAttacks.length > 4 ? ` + ${benchmark.rulesOnly.missedAttacks.length - 4} more in docs/BENCHMARK.md` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
