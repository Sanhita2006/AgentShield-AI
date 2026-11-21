import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { soundEngine } from '../utils/soundEffects.ts';
import { downloadAuditChainPdf } from '../utils/pdfReceipt.ts';

interface AuditEntry {
  seq: number;
  id: string;
  timestamp: number;
  request_id: string;
  agent_id: string;
  agent_name: string;
  action: string;
  payload_hash: string;
  decision: string;
  risk_score: number;
  reasons: string[];
  stage_results: Array<{ stage: number; name: string; status: string; latencyMs: number; summary: string }>;
  prev_hash: string;
  entry_hash: string;
  hmac_sig: string;
}

interface VerifyResult {
  valid: boolean;
  totalEntries: number;
  verifiedEntries: number;
  brokenIndex: number | null;
  brokenEntryId: string | null;
  reason: string | null;
  expectedHash?: string;
  actualHash?: string;
  checkedAt: number;
}


interface AuditExplorerProps {
  sseTick: number;
  onToast: (msg: string, tone?: 'info' | 'warn' | 'error' | 'success') => void;
  onAuditTamperChange?: (broken: boolean) => void;
}

export function AuditExplorer({ sseTick, onToast, onAuditTamperChange }: AuditExplorerProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [decisionFilter, setDecisionFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const loadLogs = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams();
      if (decisionFilter !== 'ALL') params.set('decision', decisionFilter);
      if (search.trim()) params.set('q', search.trim());
      const resp = await fetch(`/api/audit/logs?${params.toString()}`, { signal });
      if (resp.ok) {
        const json = (await resp.json()) as { entries: AuditEntry[] };
        setEntries(json.entries);
        if (!selected && json.entries.length > 0) {
          setSelected(json.entries[0]);
        }
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
    }
  }, [decisionFilter, search, selected]);

  useEffect(() => {
    const controller = new AbortController();
    void loadLogs(controller.signal);
    return () => controller.abort();
  }, [loadLogs, sseTick]);

  const handleVerifyChain = async () => {
    try {
      const resp = await fetch('/api/audit/verify', { method: 'POST' });
      const json = (await resp.json()) as VerifyResult;
      setVerifyResult(json);
      onAuditTamperChange?.(!json.valid);
      if (json.valid) {
        soundEngine.playApproveSound();
        onToast(`Audit chain verified: all ${json.totalEntries} SHA-256 + HMAC links intact.`, 'success');
      } else {
        soundEngine.playDangerSound();
        onToast(`Tampering detected at index ${json.brokenIndex} (${json.brokenEntryId})!`, 'error');
      }
    } catch {
      onToast('Network error verifying audit chain.', 'error');
    }
  };

  const handleSimulateTamper = async () => {
    try {
      const resp = await fetch('/api/audit/simulate-tamper', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmDemo: true }),
      });
      const json = (await resp.json()) as { tamperedEntryId?: string; tamperedIndex?: number; error?: string };
      if (resp.ok) {
        soundEngine.playWarningSound();
        onAuditTamperChange?.(true);
        onToast(`Row ${json.tamperedEntryId} altered directly in SQLite. Click "Verify Chain" now!`, 'warn');
        void loadLogs();
      } else {
        onToast(json.error || 'Tamper simulation failed', 'error');
      }
    } catch {
      onToast('Network error simulating tamper.', 'error');
    }
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), verifyResult, entries }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentshield-audit-chain-${Date.now()}.json`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    onToast(`Exported audit chain JSON (${entries.length} entries).`, 'success');
  };

  const handleExportPdf = () => {
    if (entries.length === 0) {
      onToast('No audit entries available to export.', 'warn');
      return;
    }
    downloadAuditChainPdf(entries, verifyResult);
    onToast(`Exported audit chain PDF (${entries.length} entries).`, 'success');
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-orange-500">Stage 5 · SHA-256 + HMAC Append-Only Ledger</p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mt-1">
            Tamper-Evident Audit Explorer
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2 no-print">
          <button
            type="button"
            onClick={handleVerifyChain}
            className="px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Verify Chain</span>
          </button>
          <button
            type="button"
            onClick={handleSimulateTamper}
            className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <ShieldAlert className="w-4 h-4" />
            <span>Simulate Tampering</span>
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            className="px-3 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON</span>
          </button>
          <button
            type="button"
            onClick={handleExportPdf}
            className="px-3 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Export PDF</span>
          </button>
        </div>
      </div>

      {/* Friendly 3-Step Guide */}
      <div className="rounded-xl border border-white/14 bg-black/78 px-5 py-3 text-xs text-slate-300 flex flex-wrap items-center gap-x-4 gap-y-1.5 no-print">
        <span className="font-semibold text-orange-400">How to test cryptographic proof:</span>
        <span>1. Click <strong className="text-white">Verify Chain</strong> (green intact)</span>
        <span className="text-slate-600">→</span>
        <span>2. Click <strong className="text-white">Simulate Tampering</strong> (alters SQLite row)</span>
        <span className="text-slate-600">→</span>
        <span>3. Click <strong className="text-white">Verify Chain</strong> again to pinpoint the exact breach</span>
      </div>

      {/* Chain Verification Status Banner */}
      {verifyResult && (
        <div
          className={`rounded-xl border p-4 flex items-start gap-3 ${
            verifyResult.valid
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-rose-500/50 bg-rose-500/10'
          }`}
        >
          {verifyResult.valid ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
          )}
          <div className="text-xs space-y-1">
            <div className="font-semibold text-sm text-slate-900 dark:text-white">
              {verifyResult.valid
                ? `Integrity Verified: ${verifyResult.verifiedEntries}/${verifyResult.totalEntries} chained entries match SHA-256 + HMAC`
                : `CHAIN BROKEN AT INDEX ${verifyResult.brokenIndex} (${verifyResult.brokenEntryId})`}
            </div>
            {verifyResult.reason && <div className="text-rose-500 font-medium">{verifyResult.reason}</div>}
            {verifyResult.expectedHash && (
              <div className="font-mono text-[11px] text-slate-500">
                Expected: {verifyResult.expectedHash.slice(0, 32)}... · Stored: {verifyResult.actualHash?.slice(0, 32)}...
              </div>
            )}
          </div>
        </div>
      )}

      {/* Search & Filter Controls */}
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between no-print">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by agent, action, reason, or audit ID..."
            className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-white/14 bg-black/84 text-slate-900 dark:text-white"
          />
        </div>
        <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200 dark:bg-slate-900 self-start">
          {['ALL', 'ALLOW', 'ASK_CUSTOMER', 'BLOCK'].map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setDecisionFilter(tab)}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                decisionFilter === tab
                  ? 'bg-white dark:bg-orange-500 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Table + "Why was this decided" Detail Panel */}
      <div className="grid lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 rounded-2xl border border-white/14 bg-black/84 p-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="pb-2 font-medium">Seq</th>
                <th className="pb-2 font-medium">Agent / Action</th>
                <th className="pb-2 font-medium">Decision</th>
                <th className="pb-2 font-medium text-right">Score</th>
                <th className="pb-2 font-medium text-right">Entry Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
              {entries.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setSelected(e)}
                  className={`cursor-pointer transition-colors ${
                    selected?.id === e.id ? 'bg-orange-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-900/60'
                  }`}
                >
                  <td className="py-2.5 pr-2 font-mono text-slate-500">#{e.seq}</td>
                  <td className="py-2.5 pr-2">
                    <div className="font-semibold text-slate-900 dark:text-white">{e.agent_name || e.agent_id}</div>
                    <div className="text-[11px] text-slate-500">{e.action}</div>
                  </td>
                  <td className="py-2.5 pr-2">
                    <span
                      className={`font-mono font-bold ${
                        e.decision === 'ALLOW'
                          ? 'text-emerald-500'
                          : e.decision === 'ASK_CUSTOMER'
                          ? 'text-amber-500'
                          : 'text-rose-500'
                      }`}
                    >
                      {e.decision}
                    </span>
                  </td>
                  <td className="py-2.5 pr-2 text-right font-mono tabular-nums">{e.risk_score}</td>
                  <td className="py-2.5 text-right font-mono text-[11px] text-slate-500">
                    {e.entry_hash.slice(0, 12)}...
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="lg:col-span-5 rounded-2xl border border-white/14 bg-black/84 p-6">
          {selected ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                <div>
                  <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                    Why Was This Decided?
                  </h2>
                  <div className="font-mono text-xs text-slate-500">
                    Seq #{selected.seq} · {selected.id}
                  </div>
                </div>
                <span className="font-mono text-sm font-bold text-orange-500">Score {selected.risk_score}/100</span>
              </div>

              <div className="text-xs space-y-1.5">
                <div className="font-semibold text-slate-900 dark:text-white">Explainable Reasons</div>
                {selected.reasons.map((r, idx) => (
                  <p key={idx} className="text-slate-600 dark:text-slate-300">
                    · {r}
                  </p>
                ))}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-900 dark:text-white">Stage Results</div>
                {selected.stage_results.map((st) => (
                  <div
                    key={st.stage}
                    className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-2.5 text-xs flex justify-between gap-2"
                  >
                    <div>
                      <span className="font-semibold text-slate-900 dark:text-white">
                        S{st.stage} {st.name}:
                      </span>{' '}
                      <span className="text-slate-600 dark:text-slate-400">{st.summary}</span>
                    </div>
                    <span className="font-mono font-semibold shrink-0">{st.status}</span>
                  </div>
                ))}
              </div>

              <div className="rounded-lg bg-slate-100 dark:bg-slate-950 p-3 font-mono text-[11px] space-y-1 break-all text-slate-600 dark:text-slate-400">
                <div>prev_hash: {selected.prev_hash}</div>
                <div className="text-emerald-500">entry_hash: {selected.entry_hash}</div>
                <div>hmac_sig: {selected.hmac_sig}</div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-500 py-8 text-center">Select an audit entry to inspect cryptographic proofs.</div>
          )}
        </div>
      </div>
    </div>
  );
}
