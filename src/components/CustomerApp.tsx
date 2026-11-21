import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  KeyRound,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { soundEngine } from '../utils/soundEffects.ts';
import {
  downloadAllTransactionsPdf,
  downloadTransactionPdf,
  type PdfTransactionItem,
} from '../utils/pdfReceipt.ts';
import type { AppRoute } from './LandingPage.tsx';
import DitherVeilBackground from './DitherVeilBackground.tsx';

interface CustomerOverview {
  customer: { id: string; name: string; email: string; city: string };
  accounts: Array<{ id: string; account_number: string; account_type: string; balance: number; balance_paise?: number; currency: string }>;
  payees: Array<{ id: string; name: string; vpa: string; category: string; verified: number }>;
  agents: Array<{ id: string; name: string; publisher: string; description: string; status: string; risk_tier: string }>;
  grants: Array<{
    id: string;
    agent_id: string;
    agent_name: string;
    agent_publisher: string;
    title: string;
    allowed_actions: string[];
    allowed_categories: string[];
    per_txn_limit: number;
    daily_limit: number;
    monthly_limit: number;
    daily_spent: number;
    monthly_spent: number;
    valid_until: number;
    status: 'active' | 'revoked' | 'expired';
    revoked_at: number | null;
  }>;
  pendingApprovals: Array<{
    id: string;
    request_id: string;
    agent_name: string;
    summary: string;
    reasons: string[];
    risk_score: number;
    is_hazardous?: number;
    expires_at: number;
    created_at: number;
  }>;
  activityFeed: Array<{
    id: string;
    agent_name: string;
    action: string;
    payee_name: string | null;
    amount: number;
    verdict: 'ALLOW' | 'ASK_CUSTOMER' | 'BLOCK' | null;
    risk_score: number | null;
    reasons: string[];
    latency_ms: number | null;
    created_at: number;
  }>;
  alerts: Array<{
    id: string;
    severity: string;
    title: string;
    message: string;
    created_at: number;
  }>;
  recentTransactions: PdfTransactionItem[];
  preferences?: {
    alwaysAskCustomer: boolean;
    askCustomerOnBlock: boolean;
  };
}

interface CustomerAppProps {
  sseTick: number;
  onToast: (msg: string, tone?: 'info' | 'warn' | 'error' | 'success') => void;
  onNavigate?: (route: AppRoute) => void;
}

function formatInr(rupees: number, paise?: number): string {
  const value = typeof paise === 'number' && Number.isFinite(paise) ? paise / 100 : Number(rupees || 0);
  const hasDecimals = Math.round(value * 100) % 100 !== 0;
  return `₹${value.toLocaleString('en-IN', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

export function CustomerApp({ sseTick, onToast, onNavigate }: CustomerAppProps) {
  const [data, setData] = useState<CustomerOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [revokedProof, setRevokedProof] = useState<{ grantId: string; ms: number } | null>(null);
  const [pinInputs, setPinInputs] = useState<Record<string, string>>({});
  const [trustPayee, setTrustPayee] = useState<Record<string, boolean>>({});
  const [showWizard, setShowWizard] = useState(false);
  const [simulatingApproval, setSimulatingApproval] = useState(false);
  const [updatingPref, setUpdatingPref] = useState<string | null>(null);
  const [escalatingRequestId, setEscalatingRequestId] = useState<string | null>(null);

  // Grant Wizard State
  const [wizAgent, setWizAgent] = useState('agent_billpay');
  const [wizTitle, setWizTitle] = useState('Pay electricity bills up to ₹5,000 until Dec 31');
  const [wizActions, setWizActions] = useState<string[]>(['pay_bill', 'check_balance']);
  const [wizCats, setWizCats] = useState<string[]>(['electricity']);
  const [wizPerTxn, setWizPerTxn] = useState(5000);
  const [wizDaily, setWizDaily] = useState(10000);
  const [wizMonthly, setWizMonthly] = useState(25000);
  const [wizExpiry, setWizExpiry] = useState('2026-12-31');

  const fetchOverview = useCallback(async (signal?: AbortSignal) => {
    try {
      const resp = await fetch('/api/customer/overview', { signal });
      if (resp.ok) {
        const json = (await resp.json()) as CustomerOverview;
        setData(json);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchOverview(controller.signal);
    return () => controller.abort();
  }, [fetchOverview, sseTick]);

  const handleRevoke = async (grantId: string, title: string) => {
    try {
      const resp = await fetch(`/api/customer/grants/${grantId}/revoke`, { method: 'POST' });
      const json = (await resp.json()) as { revokedInMs?: number; error?: string };
      if (resp.ok) {
        const ms = json.revokedInMs ?? 1.2;
        soundEngine.playRevokeSound();
        setRevokedProof({ grantId, ms });
        onToast(`Revoked "${title}" in ${ms} ms — active tokens revoked.`, 'warn');
        void fetchOverview();
      } else {
        onToast(json.error || 'Could not revoke grant.', 'error');
      }
    } catch {
      onToast('Network error revoking grant.', 'error');
    }
  };

  const handleResolveApproval = async (approvalId: string, decision: 'approve' | 'deny') => {
    try {
      const resp = await fetch(`/api/customer/approvals/${approvalId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          pin: decision === 'approve' ? pinInputs[approvalId] ?? '' : undefined,
          trustPayee: decision === 'approve' ? trustPayee[approvalId] === true : undefined,
        }),
      });
      const json = (await resp.json()) as { error?: string; status?: string };
      setPinInputs((prev) => ({ ...prev, [approvalId]: '' })); // never leave a PIN sitting in the field
      if (!resp.ok) {
        soundEngine.playDangerSound();
        onToast(json.error || 'Approval failed', 'error');
        return;
      }
      if (decision === 'approve') {
        soundEngine.playApproveSound();
      } else {
        soundEngine.playRevokeSound();
      }
      onToast(
        decision === 'approve' ? 'One-time payment approved and settled at bank.' : 'Suspicious request denied.',
        decision === 'approve' ? 'success' : 'info'
      );
      void fetchOverview();
    } catch {
      onToast('Network error resolving approval.', 'error');
    }
  };

  const handleSimulatePrePaymentApproval = async () => {
    setSimulatingApproval(true);
    try {
      const resp = await fetch('/api/gateway/scenario', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'customer_approval_payment' }),
      });
      if (resp.ok) {
        soundEngine.playWarningSound();
        onToast('Payment paused before initiation! Enter PIN 2026 below to approve or deny.', 'warn');
        void fetchOverview();
      } else {
        onToast('Could not initiate approval simulation.', 'error');
      }
    } catch {
      onToast('Network error initiating approval simulation.', 'error');
    } finally {
      setSimulatingApproval(false);
    }
  };

  const handleTogglePreference = async (
    key: 'alwaysAskCustomer' | 'askCustomerOnBlock',
    nextValue: boolean
  ) => {
    setUpdatingPref(key);
    try {
      const resp = await fetch('/api/customer/settings/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: nextValue }),
      });
      if (resp.ok) {
        if (key === 'askCustomerOnBlock' && nextValue) {
          soundEngine.playWarningSound();
          onToast('Enabled: Blocked payments will ask you to approve or deny (HIGHLY HAZARDOUS).', 'warn');
        } else if (key === 'alwaysAskCustomer' && nextValue) {
          onToast('Enabled: All payments will ask for your approval before executing.', 'info');
        } else {
          onToast('Approval preference updated.', 'success');
        }
        void fetchOverview();
      } else {
        onToast('Could not update approval preference.', 'error');
      }
    } catch {
      onToast('Network error updating approval preference.', 'error');
    } finally {
      setUpdatingPref(null);
    }
  };

  const handleEscalateBlockedRequest = async (requestId: string) => {
    setEscalatingRequestId(requestId);
    try {
      const resp = await fetch(`/api/customer/requests/${requestId}/escalate-blocked`, {
        method: 'POST',
      });
      const json = (await resp.json()) as { error?: string };
      if (!resp.ok) {
        soundEngine.playDangerSound();
        onToast(json.error || 'Could not escalate blocked payment.', 'error');
        return;
      }
      soundEngine.playWarningSound();
      onToast(
        'WARNING: THIS COULD BE HIGHLY HAZARDOUS — Review Pending Approvals with PIN 2026 to approve or deny.',
        'warn'
      );
      void fetchOverview();
    } catch {
      onToast('Network error escalating blocked payment.', 'error');
    } finally {
      setEscalatingRequestId(null);
    }
  };

  const handleCreateGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const expiryMs = new Date(`${wizExpiry}T23:59:59+05:30`).getTime();
      const resp = await fetch('/api/customer/grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: wizAgent,
          title: wizTitle,
          allowedActions: wizActions,
          allowedCategories: wizCats,
          payeeAllowlist: [],
          perTxnLimit: Number(wizPerTxn),
          dailyLimit: Number(wizDaily),
          monthlyLimit: Number(wizMonthly),
          validUntil: expiryMs,
        }),
      });
      if (resp.ok) {
        onToast(`Created grant: "${wizTitle}"`, 'success');
        setShowWizard(false);
        void fetchOverview();
      } else {
        const err = (await resp.json()) as { error?: string };
        onToast(err.error || 'Failed to create grant', 'error');
      }
    } catch {
      onToast('Network error creating grant.', 'error');
    }
  };

  if (loading || !data) {
    return (
      <>
        <DitherVeilBackground />
        <div className="relative z-10 max-w-6xl mx-auto px-6 py-12">
          <div className="h-64 rounded-2xl bg-slate-200/70 dark:bg-slate-900/80 animate-pulse" />
        </div>
      </>
    );
  }

  const account = data.accounts[0];

  return (
    <>
      <DitherVeilBackground />
      <div className="relative z-10 max-w-6xl mx-auto px-6 py-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <p className="text-xs font-medium text-orange-500">Customer Mobile Experience · Real-Time SSE Sync</p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mt-1">
            {data.customer.name} · {data.customer.city}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Control exact agent mandates, approve risky edge-cases, or revoke permissions in milliseconds.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowWizard((s) => !s)}
          className="px-4 py-2.5 text-sm font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 self-start"
        >
          <Plus className="w-4 h-4" />
          <span>{showWizard ? 'Close Grant Wizard' : 'Grant Agent Access'}</span>
        </button>
      </div>

      {/* Revocation Millisecond Proof Banner */}
      {revokedProof && (
        <div className="mb-6 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white">
                Instant Revocation Proof: Revoked in <span className="font-mono text-emerald-400">{revokedProof.ms} ms</span>
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-400">
                Grant ({revokedProof.grantId}) and all issued delegation JWTs were invalidated immediately. The very next request is blocked at Stage 1/2.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setRevokedProof(null)}
            className="text-slate-400 hover:text-white p-1"
            aria-label="Dismiss proof"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Grant Wizard Modal / Inline Drawer */}
      {showWizard && (
        <form
          onSubmit={handleCreateGrant}
          className="mb-8 rounded-2xl border border-white/20 bg-black/28 p-6"
        >
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4">
            New Scoped Agent Delegation
          </h2>
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">AI Agent</label>
              <select
                value={wizAgent}
                onChange={(e) => setWizAgent(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
              >
                {data.agents.map((ag) => (
                  <option key={ag.id} value={ag.id}>
                    {ag.name} ({ag.publisher})
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Mandate Description</label>
              <input
                type="text"
                required
                value={wizTitle}
                onChange={(e) => setWizTitle(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Allowed Actions</label>
              <div className="flex flex-wrap gap-2">
                {['check_balance', 'pay_bill', 'transfer', 'add_payee'].map((act) => (
                  <button
                    key={act}
                    type="button"
                    onClick={() =>
                      setWizActions((prev) =>
                        prev.includes(act) ? prev.filter((x) => x !== act) : [...prev, act]
                      )
                    }
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                      wizActions.includes(act)
                        ? 'bg-orange-500 border-orange-500 text-white'
                        : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {act}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Allowed Categories</label>
              <div className="flex flex-wrap gap-2">
                {['electricity', 'telecom', 'water', 'gas'].map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() =>
                      setWizCats((prev) =>
                        prev.includes(cat) ? prev.filter((x) => x !== cat) : [...prev, cat]
                      )
                    }
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                      wizCats.includes(cat)
                        ? 'bg-sky-600 border-sky-600 text-white'
                        : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Valid Until</label>
              <input
                type="date"
                value={wizExpiry}
                onChange={(e) => setWizExpiry(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Per-Transaction Limit (₹)</label>
              <input
                type="number"
                min={0}
                value={wizPerTxn}
                onChange={(e) => setWizPerTxn(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Daily Cap (₹)</label>
              <input
                type="number"
                min={0}
                value={wizDaily}
                onChange={(e) => setWizDaily(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">Monthly Cap (₹)</label>
              <input
                type="number"
                min={0}
                value={wizMonthly}
                onChange={(e) => setWizMonthly(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white"
              />
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowWizard(false)}
              className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 text-xs font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded-lg"
            >
              Issue Scoped Grant
            </button>
          </div>
        </form>
      )}

      {/* Two-Column Layout: Left Mobile Banking Frame + Right Activity & Security Feed */}
      <div className="grid lg:grid-cols-12 gap-8 items-start">
        {/* Left: Mobile-First Banking Shell */}
        <div className="lg:col-span-5 mx-auto w-full max-w-[420px] rounded-[28px] border-2 border-white/20 bg-black/22 p-5 shadow-2xl">
          <div className="flex items-center justify-between pb-4 border-b border-white/15">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <Smartphone className="w-4 h-4 text-orange-500" />
              <span>IndiBank Mobile · Protected</span>
            </div>
            <span className="font-mono text-xs text-slate-300">{account?.account_number}</span>
          </div>

          {/* Account Balance Card */}
          <div className="mt-4 rounded-2xl bg-black/28 border border-white/15 p-5 text-white">
            <div className="text-xs text-slate-400">Available Savings Balance</div>
            <div className="font-mono text-3xl font-bold tabular-nums mt-1">
              {account ? formatInr(account.balance, account.balance_paise) : '₹0'}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-slate-300">
              <span>{data.payees.length} Verified Payees</span>
              <span>{data.grants.filter((g) => g.status === 'active').length} Active Agent Mandates</span>
            </div>
          </div>

          {/* Live Pending Approvals (SSE Push) */}
          <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <h2 className="text-sm font-semibold text-white">
                Pending Approvals ({data.pendingApprovals.length})
              </h2>
              <span className="text-[11px] text-slate-400">Step-up PIN required to approve (demo PIN: 2026)</span>
            </div>

            {/* Customer Approval Policy Toggles */}
            <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
              <label className="flex items-start justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-xs font-medium text-slate-200">Ask approval before any payment</div>
                  <div className="text-[11px] text-slate-400">
                    Hold even routine payments for PIN confirmation before bank execution.
                  </div>
                </div>
                <input
                  type="checkbox"
                  disabled={updatingPref === 'alwaysAskCustomer'}
                  checked={Boolean(data.preferences?.alwaysAskCustomer)}
                  onChange={(e) => handleTogglePreference('alwaysAskCustomer', e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-600 accent-amber-500 cursor-pointer"
                />
              </label>
              <label className="flex items-start justify-between gap-3 pt-2 border-t border-white/10 cursor-pointer">
                <div>
                  <div className="text-xs font-medium text-rose-300 flex items-center gap-1">
                    <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    <span>Ask approve/deny on BLOCKED payments</span>
                  </div>
                  <div className="text-[11px] text-rose-300/80">
                    Warning: THIS COULD BE HIGHLY HAZARDOUS — lets you override security blocks with PIN 2026.
                  </div>
                </div>
                <input
                  type="checkbox"
                  disabled={updatingPref === 'askCustomerOnBlock'}
                  checked={Boolean(data.preferences?.askCustomerOnBlock)}
                  onChange={(e) => handleTogglePreference('askCustomerOnBlock', e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-rose-500 accent-rose-500 cursor-pointer"
                />
              </label>
            </div>

            {data.pendingApprovals.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-4 text-xs text-slate-400 space-y-2.5">
                <p>No agent payments waiting for your approval right now.</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={simulatingApproval}
                    onClick={handleSimulatePrePaymentApproval}
                    className="px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors disabled:opacity-50"
                  >
                    {simulatingApproval ? 'Requesting Approval...' : 'Ask Approval Before Paying ₹2,400'}
                  </button>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate('attack-lab')}
                      className="px-3 py-1.5 text-xs font-semibold bg-white/10 hover:bg-white/15 text-orange-400 rounded-lg transition-colors"
                    >
                      Open Attack Lab →
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {data.pendingApprovals.map((ap) => {
                  const isHazardous = ap.is_hazardous === 1;
                  return (
                    <div
                      key={ap.id}
                      className={`rounded-xl border p-4 ${
                        isHazardous
                          ? 'border-rose-500 bg-rose-950/40'
                          : 'border-amber-500/70 bg-amber-500/10 animate-pulse'
                      }`}
                      style={isHazardous ? undefined : { animationDuration: '2.6s' }}
                    >
                      {isHazardous && (
                        <div className="mb-3 rounded-lg border border-rose-500/80 bg-rose-600/25 px-3 py-2.5 flex items-start gap-2.5">
                          <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                          <div>
                            <div className="text-xs font-extrabold tracking-wide text-rose-200 uppercase">
                              WARNING: THIS COULD BE HIGHLY HAZARDOUS
                            </div>
                            <p className="text-[11px] text-rose-100/90 mt-0.5 leading-snug">
                              AgentShield blocked this payment due to high-risk security signals. Approving overrides the block and initiates the payment.
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="flex items-start justify-between gap-2">
                        <div
                          className={`text-xs font-semibold flex items-center gap-1.5 ${
                            isHazardous ? 'text-rose-300' : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          <span>{isHazardous ? 'Blocked Payment Override Request' : 'Action Requires Confirmation'}</span>
                        </div>
                        <span
                          className={`font-mono text-xs font-bold tabular-nums ${
                            isHazardous ? 'text-rose-400' : 'text-amber-500'
                          }`}
                        >
                          Risk {ap.risk_score}/100
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-white mt-2">{ap.summary}</p>
                      <ul className="mt-2 space-y-1 text-xs text-slate-700 dark:text-slate-300">
                        {ap.reasons.map((r, idx) => (
                          <li key={idx}>· {r}</li>
                        ))}
                      </ul>

                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-2">
                          <KeyRound className="w-3.5 h-3.5 text-slate-400" />
                          <input
                            type="password"
                            inputMode="numeric"
                            maxLength={6}
                            autoComplete="off"
                            placeholder="Enter PIN (2026)"
                            value={pinInputs[ap.id] ?? ''}
                            onChange={(e) => setPinInputs((prev) => ({ ...prev, [ap.id]: e.target.value.replace(/\D/g, '') }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && (pinInputs[ap.id] ?? '').length >= 4) handleResolveApproval(ap.id, 'approve');
                            }}
                            className="w-40 px-2.5 py-1 text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                          />
                        </div>
                        {!isHazardous && (
                          <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={trustPayee[ap.id] === true}
                              onChange={(e) => setTrustPayee((prev) => ({ ...prev, [ap.id]: e.target.checked }))}
                              className="rounded border-slate-500"
                            />
                            <span>Always trust this payee</span>
                          </label>
                        )}
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleResolveApproval(ap.id, 'approve')}
                          disabled={(pinInputs[ap.id] ?? '').length < 4}
                          title={(pinInputs[ap.id] ?? '').length < 4 ? 'Enter your PIN to approve' : undefined}
                          className={`px-3 py-2 text-xs font-semibold text-white rounded-lg flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed ${
                            isHazardous ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'
                          }`}
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{isHazardous ? 'Approve Anyway (Hazardous)' : 'Approve Once'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResolveApproval(ap.id, 'deny')}
                          className="px-3 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg flex items-center justify-center gap-1.5"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>Deny</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Active Agent Grants with Spend Meters & Big Red Revoke */}
          <div className="mt-6">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">My Authorized Agents</h2>
            <div className="space-y-3">
              {data.grants.map((g) => {
                const dailyPct = g.daily_limit > 0 ? Math.min(100, Math.round((g.daily_spent / g.daily_limit) * 100)) : 0;
                const isActive = g.status === 'active';
                return (
                  <div
                    key={g.id}
                    className={`rounded-xl border p-4 ${
                      isActive
                        ? 'border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-black/25'
                        : 'border-slate-200/60 dark:border-white/10 bg-transparent opacity-65'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">{g.agent_name}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{g.title}</div>
                      </div>
                      <span
                        className={`font-mono text-[11px] font-semibold ${
                          isActive ? 'text-emerald-500' : 'text-rose-500'
                        }`}
                      >
                        {g.status.toUpperCase()}
                      </span>
                    </div>

                    <div className="mt-2.5 text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-2">
                      <span>Actions: {g.allowed_actions.join(', ')}</span>
                      <span>·</span>
                      <span>Cap: {formatInr(g.per_txn_limit)}/txn</span>
                    </div>

                    {g.daily_limit > 0 && (
                      <div className="mt-3">
                        <div className="flex justify-between text-[11px] font-mono text-slate-500 dark:text-slate-400 mb-1">
                          <span>24h Spend</span>
                          <span>
                            {formatInr(g.daily_spent)} / {formatInr(g.daily_limit)}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                          <div className="h-full bg-orange-500 rounded-full" style={{ width: `${dailyPct}%` }} />
                        </div>
                      </div>
                    )}

                    {isActive && (
                      <button
                        type="button"
                        onClick={() => handleRevoke(g.id, g.title)}
                        className="mt-3 w-full py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white rounded-lg transition-colors"
                      >
                        Revoke Access Instantly
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right: Plain-Language Activity Feed & Security Alerts */}
        <div className="lg:col-span-7 space-y-6">
          {/* Customer Security Alerts */}
          {data.alerts.length > 0 && (
            <div className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-6">
              <h2 className="font-display text-base font-bold text-rose-500 flex items-center gap-2 mb-3">
                <ShieldAlert className="w-4 h-4" />
                <span>Real-Time Threat Alerts ({data.alerts.length})</span>
              </h2>
              <div className="divide-y divide-rose-500/20">
                {data.alerts.slice(0, 4).map((al) => (
                  <div key={al.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">{al.title}</span>
                      <span className="font-mono text-[11px] text-slate-500">
                        {new Date(al.created_at).toLocaleTimeString('en-IN')}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">{al.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Completed Bank Transactions with PDF Download */}
          <div className="rounded-2xl border border-white/18 bg-black/22 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                  Completed Bank Transactions
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Download individual transaction receipts or your full statement in PDF format.
                </p>
              </div>
              {data.recentTransactions.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    downloadAllTransactionsPdf(data.recentTransactions, data.customer, account);
                    onToast('Downloaded transaction statement PDF.', 'success');
                  }}
                  className="px-3 py-1.5 text-xs font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Download Statement PDF</span>
                </button>
              )}
            </div>

            {data.recentTransactions.length === 0 ? (
              <div className="text-xs text-slate-400 py-4">No settled bank transactions yet.</div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-80 overflow-y-auto pr-1">
                {data.recentTransactions.map((tx) => (
                  <div key={tx.id} className="py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-semibold text-slate-900 dark:text-white">{tx.payee_name}</span>
                        <span className="text-xs font-mono text-slate-400">· {tx.category}</span>
                        <span className="text-[11px] font-mono text-emerald-500 uppercase">{tx.status}</span>
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                        {tx.note || tx.action.replace('_', ' ')} ·{' '}
                        {new Date(tx.created_at).toLocaleString('en-IN', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-mono text-sm font-bold text-slate-900 dark:text-white tabular-nums">
                        {formatInr(tx.amount, tx.amount_paise)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          downloadTransactionPdf(tx, data.customer, account);
                          onToast(`Downloaded PDF receipt for ${tx.payee_name}.`, 'success');
                        }}
                        className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
                        title="Download transaction receipt as PDF"
                      >
                        <Download className="w-3.5 h-3.5 text-orange-400" />
                        <span>PDF</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Plain-Language Agent Activity Feed */}
          <div className="rounded-2xl border border-white/18 bg-black/22 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                  Plain-Language Agent Activity
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Every decision explained clearly for account holders.
                </p>
              </div>
              <ShieldCheck className="w-5 h-5 text-emerald-500" />
            </div>

            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.activityFeed.map((item) => {
                const canEscalateBlocked =
                  item.verdict === 'BLOCK' &&
                  (item.action === 'pay_bill' || item.action === 'transfer' || item.action === 'add_payee');
                return (
                  <div key={item.id} className="py-3.5 flex items-start justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-semibold text-slate-900 dark:text-white">{item.agent_name}</span>
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-600 dark:text-slate-300">
                          {item.action.replace('_', ' ')} {item.payee_name ? `to ${item.payee_name}` : ''}
                        </span>
                        {item.amount > 0 && (
                          <>
                            <span className="text-slate-400">·</span>
                            <span className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
                              {formatInr(item.amount)}
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                        {item.reasons[0] || 'Processed by AgentShield pipeline.'}
                      </p>
                      {canEscalateBlocked && (
                        <button
                          type="button"
                          disabled={escalatingRequestId === item.id}
                          onClick={() => handleEscalateBlockedRequest(item.id)}
                          className="mt-2 px-2.5 py-1 text-[11px] font-semibold rounded-md border border-rose-500/60 bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
                        >
                          <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          <span>
                            {escalatingRequestId === item.id
                              ? 'Sending to Approvals...'
                              : 'Ask Customer Anyway (Highly Hazardous)'}
                          </span>
                        </button>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <span
                        className={`inline-block font-mono text-xs font-bold ${
                          item.verdict === 'ALLOW'
                            ? 'text-emerald-500'
                            : item.verdict === 'ASK_CUSTOMER'
                            ? 'text-amber-500'
                            : 'text-rose-500'
                        }`}
                      >
                        {item.verdict || 'PENDING'}
                      </span>
                      <div className="font-mono text-[11px] text-slate-500 flex items-center justify-end gap-1 mt-0.5">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(item.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
