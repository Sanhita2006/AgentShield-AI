export type AgentAction = 'check_balance' | 'pay_bill' | 'transfer' | 'add_payee';
export type ContextProvenance = 'user_instruction' | 'tool_output' | 'untrusted_document' | 'web_content';

export interface AgentShieldExecuteOptions {
  action: AgentAction;
  params: {
    accountId?: string;
    payeeId?: string;
    payeeName?: string;
    payeeVpa?: string;
    category?: string;
    amount?: number;
    note?: string;
  };
  intent: string;
  provenance: ContextProvenance;
  contextSnippet?: string;
  idempotencyKey?: string;
}

export class AgentShieldClient {
  private baseUrl: string;
  private token: string;
  private fingerprint: {
    agentRuntimeId: string;
    ip: string;
    asn: string;
    userAgent: string;
  };

  constructor(config: {
    baseUrl?: string;
    token: string;
    agentRuntimeId: string;
    ip?: string;
    asn?: string;
    userAgent?: string;
  }) {
    this.baseUrl = config.baseUrl ?? '';
    this.token = config.token;
    this.fingerprint = {
      agentRuntimeId: config.agentRuntimeId,
      ip: config.ip ?? '103.21.58.14',
      asn: config.asn ?? 'AS9498',
      userAgent: config.userAgent ?? 'AgentShieldSDK/1.0',
    };
  }

  async execute(input: AgentShieldExecuteOptions) {
    const nonce =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `nonce_${Math.random().toString(36).slice(2)}_${Date.now()}`;

    const res = await fetch(`${this.baseUrl}/api/gateway/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: this.token,
        action: input.action,
        params: input.params,
        intent: input.intent,
        provenance: input.provenance,
        contextSnippet: input.contextSnippet,
        nonce,
        timestamp: Date.now(),
        fingerprint: this.fingerprint,
        idempotencyKey: input.idempotencyKey,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || `Gateway HTTP ${res.status}`);
    }

    return res.json();
  }
}
