import React, { useEffect, useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';

export function DocsPage() {
  const [openApi, setOpenApi] = useState<Record<string, unknown> | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/docs', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setOpenApi(d);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const copyCode = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  const tsSnippet = `import { AgentShieldClient } from './sdk/agentshield-sdk';

const shield = new AgentShieldClient({
  token: process.env.AGENT_DELEGATION_JWT!,
  agentRuntimeId: 'rt_billpay_prod_kol_01',
  ip: '103.21.58.14',
  asn: 'AS9498',
});

const decision = await shield.execute({
  action: 'pay_bill',
  params: { payeeId: 'payee_cesc', category: 'electricity', amount: 1840 },
  intent: 'Pay monthly CESC Kolkata electricity bill',
  provenance: 'user_instruction',
});`;

  const curlSnippet = `curl -X POST http://localhost:3000/api/gateway/execute \\
  -H "Content-Type: application/json" \\
  -d '{
    "token": "<DELEGATION_JWT>",
    "action": "pay_bill",
    "params": { "payeeId": "payee_cesc", "category": "electricity", "amount": 1840 },
    "intent": "Pay monthly CESC Kolkata electricity bill",
    "provenance": "user_instruction",
    "nonce": "nonce_9182736455",
    "timestamp": 1795099492000,
    "fingerprint": {
      "agentRuntimeId": "rt_billpay_prod_kol_01",
      "ip": "103.21.58.14",
      "asn": "AS9498",
      "userAgent": "BillPayAgent/2.4.1"
    }
  }'`;

  const pythonSnippet = `import time, uuid, requests

resp = requests.post("http://localhost:3000/api/gateway/execute", json={
    "token": DELEGATION_JWT,
    "action": "pay_bill",
    "params": {"payeeId": "payee_cesc", "category": "electricity", "amount": 1840},
    "intent": "Pay monthly CESC Kolkata electricity bill",
    "provenance": "user_instruction",
    "nonce": str(uuid.uuid4()),
    "timestamp": int(time.time() * 1000),
    "fingerprint": {
        "agentRuntimeId": "rt_billpay_prod_kol_01",
        "ip": "103.21.58.14",
        "asn": "AS9498",
        "userAgent": "BillPayAgent/2.4.1"
    }
})
print(resp.json()["verdict"], resp.json()["riskScore"])`;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      <div>
        <p className="text-xs font-medium text-orange-500">AgentShield SDK & OpenAPI Specification</p>
        <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white mt-1">
          Integrate Any AI Agent Framework in 5 Minutes
        </h1>
      </div>

      {/* Threat Model Matrix */}
      <div className="rounded-2xl border border-white/14 bg-black/84 p-6 overflow-x-auto">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4">Threat Model Coverage</h2>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
              <th className="pb-2 font-medium">Attack Vector</th>
              <th className="pb-2 font-medium">Stopping Stage</th>
              <th className="pb-2 font-medium">Mechanism</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
            {[
              ['Stolen Bearer / Delegation JWT', 'Stage 1 (Identity)', 'Device/IP/ASN fingerprint hash mismatch suspends token (re-issue required) & alerts customer'],
              ['HTTP Request Replay', 'Stage 1 (Identity)', '60-second timestamp skew window + consumed nonce registry'],
              ['Over-Permissioned Read-Only Agent', 'Stage 2 (Delegation)', 'Default-deny allowed_actions & category allowlist'],
              ['Revoked or Expired Mandate', 'Stage 2 (Delegation)', 'Instant DB status invalidation (<5ms enforcement)'],
              ['Indirect Prompt Injection in PDF/Web', 'Stage 3 (Behaviour)', 'Provenance tag check + injection heuristic snippet matcher + intent check'],
              ['Smurfing / Structuring (₹4,999 x2)', 'Stage 3 (Behaviour)', '92-100% ceiling clustering + sliding window frequency burst'],
              ['New Payee at 3:00 AM', 'Stage 3 & 4', 'Z-score + unusual hour escalation -> SSE push + PIN step-up'],
              ['Direct /api/bank/* Bypass', 'Bank Perimeter', 'Constant-time shared internal secret x-bank-internal-secret'],
              ['Post-Incident Log Tampering', 'Stage 5 (Audit)', 'SHA-256 hash chain + HMAC-SHA256 verification'],
            ].map(([threat, stage, mech]) => (
              <tr key={threat}>
                <td className="py-2.5 pr-4 font-semibold text-slate-900 dark:text-white">{threat}</td>
                <td className="py-2.5 pr-4 font-mono text-orange-500">{stage}</td>
                <td className="py-2.5 text-slate-600 dark:text-slate-300">{mech}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* SDK Snippets */}
      <div className="grid lg:grid-cols-2 gap-6">
        {[
          { id: 'ts', title: 'TypeScript SDK (agentshield-sdk)', code: tsSnippet },
          { id: 'py', title: 'Python Agent Integration', code: pythonSnippet },
        ].map((item) => (
          <div key={item.id} className="rounded-2xl border border-white/14 bg-black/88 p-5 text-slate-100">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold flex items-center gap-2">
                <Terminal className="w-4 h-4 text-orange-400" />
                {item.title}
              </span>
              <button
                type="button"
                onClick={() => copyCode(item.id, item.code)}
                className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 rounded flex items-center gap-1"
              >
                {copied === item.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copied === item.id ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <pre className="text-xs font-mono overflow-x-auto leading-relaxed text-slate-300">{item.code}</pre>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-white/14 bg-black/88 p-5 text-slate-100">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold">cURL Quick Test</span>
          <button
            type="button"
            onClick={() => copyCode('curl', curlSnippet)}
            className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 rounded flex items-center gap-1"
          >
            {copied === 'curl' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied === 'curl' ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <pre className="text-xs font-mono overflow-x-auto text-slate-300">{curlSnippet}</pre>
      </div>

      {openApi && (
        <div className="rounded-2xl border border-white/14 bg-black/84 p-6">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white mb-3">
            Live OpenAPI 3.0 Spec (/api/docs)
          </h2>
          <pre className="text-xs font-mono bg-slate-100 dark:bg-slate-950 p-4 rounded-xl overflow-x-auto text-slate-700 dark:text-slate-300">
            {JSON.stringify(openApi, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
