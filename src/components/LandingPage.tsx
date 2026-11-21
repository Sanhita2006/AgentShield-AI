import React, { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Lock, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { soundEngine } from '../utils/soundEffects.ts';
import CrystalizedBall from './CrystalizedBall.tsx';

export type AppRoute = 'landing' | 'customer' | 'console' | 'attack-lab' | 'audit' | 'docs';

interface LandingPageProps {
  onNavigate: (route: AppRoute) => void;
  onPulse: (pulse: 'allow' | 'ask' | 'block' | null) => void;
}

interface MiniDemoResult {
  scenarioId: string;
  decision: {
    requestId: string;
    verdict: 'ALLOW' | 'ASK_CUSTOMER' | 'BLOCK';
    riskScore: number;
    latencyMs: number;
    reasons: string[];
    approvalId?: string;
  };
  withoutShieldOutcome: string;
  withShieldOutcome: string;
}

export function LandingPage({ onNavigate, onPulse }: LandingPageProps) {
  const [miniLoading, setMiniLoading] = useState(false);
  const [miniResult, setMiniResult] = useState<MiniDemoResult | null>(null);
  const [miniEscalating, setMiniEscalating] = useState(false);
  const [miniEscalatedId, setMiniEscalatedId] = useState<string | null>(null);
  const [selfTestSummary, setSelfTestSummary] = useState<{
    attackScenariosStopped: number;
    attackScenariosTotal: number;
    avgLatencyMs: number;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/selftest', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.attackScenariosStopped === 'number') {
          setSelfTestSummary({
            attackScenariosStopped: data.attackScenariosStopped,
            attackScenariosTotal: data.attackScenariosTotal,
            avgLatencyMs: data.avgLatencyMs,
          });
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const runMiniScenario = async (
    scenarioId: 'legit_bill' | 'customer_approval_payment' | 'prompt_injection' | 'stolen_token'
  ) => {
    setMiniLoading(true);
    try {
      const resp = await fetch('/api/gateway/scenario', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId }),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as MiniDemoResult;
      setMiniResult(data);
      const pulse = data.decision.verdict === 'ALLOW' ? 'allow' : data.decision.verdict === 'BLOCK' ? 'block' : 'ask';
      onPulse(pulse);
      if (data.decision.verdict === 'BLOCK') soundEngine.playDangerSound();
      else if (data.decision.verdict === 'ASK_CUSTOMER') soundEngine.playWarningSound();
      else soundEngine.playApproveSound();
    } catch {
      // Ignore transient network errors
    } finally {
      setMiniLoading(false);
    }
  };

  const handleMiniEscalateBlocked = async (requestId: string) => {
    setMiniEscalating(true);
    try {
      const resp = await fetch(`/api/gateway/requests/${requestId}/escalate-blocked`, {
        method: 'POST',
      });
      if (resp.ok) {
        setMiniEscalatedId(requestId);
        soundEngine.playWarningSound();
      }
    } catch {
      // Ignore transient network errors
    } finally {
      setMiniEscalating(false);
    }
  };

  const stageItems = [
    {
      num: '01',
      title: 'Identity & Device-Bound Tokens',
      desc: 'Short-lived HS256 JWTs bound to the agent runtime ID, IP, ASN, and user-agent hash. Replaying a stolen token from another host suspends the token immediately for explicit re-issue.',
    },
    {
      num: '02',
      title: 'Scoped Delegation Engine',
      desc: 'Default-deny permissions specifying exact actions, utility categories, per-transaction caps, daily/monthly ledger ceilings, and millisecond-instant revocation.',
    },
    {
      num: '03',
      title: 'Behavioural, Intent & Provenance Engine',
      desc: 'Tracks 30-day machine baselines, detects prompt injection inside untrusted documents, and flags divergence between declared intent and bank action.',
    },
    {
      num: '04',
      title: 'Human-in-the-Loop Escalation',
      desc: 'Suspicious medium-risk requests pause execution and push an instant approval card via Server-Sent Events with optional PIN step-up.',
    },
    {
      num: '05',
      title: 'Tamper-Evident Hash-Chained Audit',
      desc: 'Every decision appends to an immutable SHA-256 + HMAC chain verifiable end-to-end for instant regulatory and customer dispute resolution.',
    },
  ];

  return (
    <div className="relative text-slate-100 pointer-events-none">
      {/* SECTION 1: HERO INTRO WITH CRYSTALIZED BALL */}
      <section className="relative min-h-[calc(100vh-4rem)] w-full overflow-hidden bg-transparent pointer-events-auto">
        <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none">
          <div style={{ width: '100%', height: '600px', position: 'relative' }}>
            <CrystalizedBall
              preset="plasma"
              color="#F25BD0"
              size={0.7}
              crackle={0.85}
              fill={0.5}
              interactive
              hoverStrength={0.7}
            />
          </div>
        </div>
        <div className="relative z-10 min-h-[calc(100vh-4rem)] max-w-6xl mx-auto px-6 pt-16 pb-16 flex flex-col justify-between items-center text-center">
          <div className="max-w-4xl mx-auto pointer-events-auto pt-8 flex flex-col items-center">
            <p className="text-xs font-semibold tracking-wide text-orange-400 mb-3 drop-shadow-[0_2px_10px_rgba(0,0,0,1)]">
              Zero-Trust Gateway for Agentic Banking · AI Agent → AgentShield → Bank
            </p>
            <h1 className="font-display text-4xl sm:text-6xl font-bold tracking-tight text-white leading-[1.08] text-balance mb-5 drop-shadow-[0_4px_24px_rgba(0,0,0,1)]">
              Let AI agents pay bills, never drain accounts.
            </h1>
            <p className="text-base sm:text-lg text-slate-100 leading-relaxed mb-8 max-w-3xl drop-shadow-[0_2px_16px_rgba(0,0,0,1)]">
              AgentShield sits between autonomous AI agents and core banking APIs. Every action passes through five deterministic security stages—blocking prompt injections, stolen tokens, and over-permissioned agents in under 50 milliseconds.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => onNavigate('attack-lab')}
                className="px-5 py-2.5 text-sm font-semibold text-white bg-orange-500 hover:bg-orange-600 rounded-lg shadow-lg transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <span>Launch Attack Lab</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('customer')}
                className="px-5 py-2.5 text-sm font-medium text-white bg-black/60 hover:bg-black/80 border border-white/25 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Customer Mobile App
              </button>
              <button
                type="button"
                onClick={() => onNavigate('console')}
                className="px-4 py-2.5 text-sm font-medium text-slate-200 hover:text-white transition-colors whitespace-nowrap shrink-0 drop-shadow-[0_2px_10px_rgba(0,0,0,1)]"
              >
                Bank Console →
              </button>
            </div>
          </div>

          <div className="w-full grid grid-cols-2 sm:grid-cols-4 gap-4 mt-12 pointer-events-auto text-left">
            <div className="bg-black/55 border border-white/20 rounded-xl p-4">
              <div className="font-mono text-2xl font-bold text-emerald-400 tabular-nums">
                {selfTestSummary ? `${selfTestSummary.attackScenariosStopped}/${selfTestSummary.attackScenariosTotal}` : '13/13'}
              </div>
              <div className="text-xs text-slate-200 mt-1">Attack scenarios stopped</div>
            </div>
            <div className="bg-black/55 border border-white/20 rounded-xl p-4">
              <div className="font-mono text-2xl font-bold text-white tabular-nums">
                {selfTestSummary ? `${selfTestSummary.avgLatencyMs} ms` : '<15 ms'}
              </div>
              <div className="text-xs text-slate-200 mt-1">Mean decision latency</div>
            </div>
            <div className="bg-black/55 border border-white/20 rounded-xl p-4">
              <div className="font-mono text-2xl font-bold text-orange-400 tabular-nums">5 Stages</div>
              <div className="text-xs text-slate-200 mt-1">Fail-closed pipeline</div>
            </div>
            <div className="bg-black/55 border border-white/20 rounded-xl p-4">
              <div className="font-mono text-2xl font-bold text-sky-400 tabular-nums">SHA-256</div>
              <div className="text-xs text-slate-200 mt-1">Tamper-evident audit chain</div>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 2: THE 3 THREATS (Full Left-to-Right Symmetrical Layout) */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="w-full pointer-events-auto bg-black/78 border border-white/14 rounded-2xl p-8">
          <div className="max-w-3xl mb-8">
            <p className="text-xs font-medium text-orange-400 mb-2">Threat Landscape · Scroll to Inspect Perimeter</p>
            <h2 className="font-display text-3xl font-bold text-white tracking-tight mb-3 text-balance">
              Three ways rogue AI agents breach bank accounts.
            </h2>
            <p className="text-sm text-slate-300 leading-relaxed">
              Traditional OAuth bearer tokens treat an agent like a human user with blanket access. When an agent reads poisoned web content or leaks its token, banks have zero visibility into why a payment happened.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6 border-t border-white/12 pt-6">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <Lock className="w-4 h-4 text-orange-400 shrink-0" />
                <span>01. Stolen Delegation Tokens</span>
              </h3>
              <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                An attacker extracts an agent JWT and replays it from an external VPS. Stage 1 validates device fingerprint bindings and suspends suspicious tokens instantly.
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-orange-400 shrink-0" />
                <span>02. Indirect Prompt Injection</span>
              </h3>
              <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                Malicious instructions hidden inside an invoice PDF hijack the LLM into transferring ₹25,000. Stage 3 inspects provenance and flags intent mismatch.
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-orange-400 shrink-0" />
                <span>03. Over-Permissioned & Smurfing Agents</span>
              </h3>
              <p className="text-sm text-slate-400 mt-2 leading-relaxed">
                A read-only budget tracker attempts a write transfer, or splits ₹4,999 payments to evade ₹5,000 caps. Stage 2 & Stage 3 enforce strict scoped grants and structuring detection.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 3: THE 5-STAGE PIPELINE (Full Left-to-Right Balanced Layout) */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="w-full pointer-events-auto bg-black/80 border border-white/14 rounded-2xl p-8">
          <div className="max-w-3xl mb-6">
            <p className="text-xs font-medium text-sky-400 mb-2">5-Layer Defense · Watch the 3D Shield Explode</p>
            <h2 className="font-display text-3xl font-bold text-white tracking-tight text-balance">
              Every agent call passes five independent security gates.
            </h2>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 border-t border-white/12 pt-6">
            {stageItems.map((st) => (
              <div key={st.num} className="rounded-xl border border-white/10 bg-white/[0.03] p-5 flex gap-3.5">
                <span className="font-mono text-sm font-semibold text-orange-400 tabular-nums shrink-0 pt-0.5">
                  {st.num}
                </span>
                <div>
                  <h3 className="text-base font-semibold text-white">{st.title}</h3>
                  <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">{st.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SECTION 4: EMBEDDED MINI LIVE DEMO */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="pointer-events-auto bg-black/84 border border-white/14 rounded-2xl p-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
            <div>
              <p className="text-xs font-medium text-orange-400 mb-1">Live Server Execution</p>
              <h2 className="font-display text-2xl font-bold text-white">
                Test the live gateway right here
              </h2>
              <p className="text-sm text-slate-400 mt-1">
                Each button dispatches a real signed request through all 5 server-side stages with live audio + 3D perimeter feedback.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={miniLoading}
                onClick={() => runMiniScenario('legit_bill')}
                className="px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Pay ₹1,840 CESC Bill
              </button>
              <button
                type="button"
                disabled={miniLoading}
                onClick={() => runMiniScenario('customer_approval_payment')}
                className="px-4 py-2 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Ask Approval Before Paying
              </button>
              <button
                type="button"
                disabled={miniLoading}
                onClick={() => runMiniScenario('prompt_injection')}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Trigger Prompt Injection
              </button>
              <button
                type="button"
                disabled={miniLoading}
                onClick={() => runMiniScenario('stolen_token')}
                className="px-4 py-2 text-xs font-semibold bg-orange-600 hover:bg-orange-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Replay Stolen Token
              </button>
            </div>
          </div>

          {miniResult ? (
            <div className="mt-6 grid md:grid-cols-3 gap-6">
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
                <div className="text-xs text-slate-400">Gateway Verdict</div>
                <div className="mt-2 flex items-center gap-2">
                  <span
                    className={`font-mono text-lg font-bold ${
                      miniResult.decision.verdict === 'ALLOW'
                        ? 'text-emerald-400'
                        : miniResult.decision.verdict === 'ASK_CUSTOMER'
                        ? 'text-amber-400'
                        : 'text-rose-400'
                    }`}
                  >
                    {miniResult.decision.verdict}
                  </span>
                  <span className="font-mono text-xs text-slate-400 tabular-nums">
                    · Risk {miniResult.decision.riskScore}/100 · {miniResult.decision.latencyMs}ms
                  </span>
                </div>
                <p className="text-xs text-slate-300 mt-2">{miniResult.decision.reasons[0]}</p>
                {miniResult.decision.verdict === 'ASK_CUSTOMER' && (
                  <button
                    type="button"
                    onClick={() => onNavigate('customer')}
                    className="mt-3 px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-black rounded-lg transition-colors"
                  >
                    Approve with PIN 2026 →
                  </button>
                )}
                {miniResult.decision.verdict === 'BLOCK' && (
                  <div className="mt-3 space-y-2">
                    {miniResult.decision.approvalId || miniEscalatedId === miniResult.decision.requestId ? (
                      <div className="rounded-lg border border-rose-500/80 bg-rose-950/60 p-2.5 space-y-2">
                        <div className="text-[11px] font-extrabold uppercase tracking-wide text-rose-200 flex items-center gap-1.5">
                          <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          <span>WARNING: THIS COULD BE HIGHLY HAZARDOUS</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => onNavigate('customer')}
                          className="w-full px-3 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors"
                        >
                          Approve or Deny in Customer App (PIN 2026) →
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={miniEscalating}
                        onClick={() => handleMiniEscalateBlocked(miniResult.decision.requestId)}
                        className="px-3 py-1.5 text-xs font-semibold border border-rose-500/70 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 rounded-lg transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        <span>{miniEscalating ? 'Escalating...' : 'Still Ask Customer (Highly Hazardous)'}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
                <div className="text-xs text-rose-400 font-medium">Without AgentShield</div>
                <p className="text-sm text-slate-200 mt-2">{miniResult.withoutShieldOutcome}</p>
              </div>
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
                <div className="text-xs text-emerald-400 font-medium">With AgentShield</div>
                <p className="text-sm text-slate-200 mt-2">{miniResult.withShieldOutcome}</p>
              </div>
            </div>
          ) : (
            <div className="mt-6 text-sm text-slate-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Select a scenario above to execute a real gateway request and watch the 3D perimeter respond.</span>
            </div>
          )}
        </div>
      </section>

      {/* SECTION 5: ROADMAP & TEAM STRIVE GBI */}
      <section className="max-w-6xl mx-auto px-6 pt-8 pb-32">
        <div className="grid md:grid-cols-2 gap-6 pointer-events-auto">
          <div className="bg-black/82 border border-white/14 rounded-2xl p-8">
            <p className="text-xs font-medium text-sky-400 mb-2">Deployment Roadmap</p>
            <h3 className="font-display text-2xl font-bold text-white mb-5">From Pilot to Multi-Bank Network</h3>
            <div className="space-y-4">
              <div className="flex gap-3">
                <span className="font-mono text-xs text-orange-400 pt-1 shrink-0">Phase 1</span>
                <div>
                  <div className="text-sm font-semibold text-white">Pilot Utility & BBPS Bill Pay</div>
                  <p className="text-xs text-slate-400 mt-0.5">Category-scoped delegation for electricity, telecom, gas, and water mandates.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="font-mono text-xs text-orange-400 pt-1 shrink-0">Phase 2</span>
                <div>
                  <div className="text-sm font-semibold text-white">UPI & NEFT Programmable Transfers</div>
                  <p className="text-xs text-slate-400 mt-0.5">Dynamic step-up approvals and behavioral ML risk scoring for peer & merchant transfers.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="font-mono text-xs text-orange-400 pt-1 shrink-0">Phase 3</span>
                <div>
                  <div className="text-sm font-semibold text-white">RBI Account Aggregator & NPCI Alignment</div>
                  <p className="text-xs text-slate-400 mt-0.5">Standardized consent artifacts across multiple banks and shared threat intelligence.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-black/82 border border-white/14 rounded-2xl p-8 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium text-orange-400 mb-2">Team Strive GBI</p>
              <h3 className="font-display text-2xl font-bold text-white mb-3 flex items-center gap-2">
                <Users className="w-5 h-5 text-orange-400" />
                <span>Built for Securing Banks Against Rogue AI Agents</span>
              </h3>
              <p className="text-sm text-slate-400 mb-6">
                Designed and engineered by Team Strive GBI with fail-closed security, Indian banking rails, and cryptographic auditability.
              </p>
              <div className="divide-y divide-slate-800 border-y border-slate-800">
                <div className="py-2.5 flex items-center justify-between text-sm">
                  <span className="font-medium text-white">Sushweta Ghosh</span>
                  <span className="text-xs text-slate-400">Security Architecture & Gateway</span>
                </div>
                <div className="py-2.5 flex items-center justify-between text-sm">
                  <span className="font-medium text-white">Sanhita Bhattacharjee</span>
                  <span className="text-xs text-slate-400">Behavioural Engine & Threat Lab</span>
                </div>
                <div className="py-2.5 flex items-center justify-between text-sm">
                  <span className="font-medium text-white">Indrani Deb Roy</span>
                  <span className="text-xs text-slate-400">Customer UX & Audit Cryptography</span>
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onNavigate('attack-lab')}
                className="px-4 py-2 text-xs font-semibold bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Open Attack Lab
              </button>
              <button
                type="button"
                onClick={() => onNavigate('audit')}
                className="px-4 py-2 text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Explore Audit Chain
              </button>
              <button
                type="button"
                onClick={() => onNavigate('docs')}
                className="px-4 py-2 text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                SDK & OpenAPI Docs
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
