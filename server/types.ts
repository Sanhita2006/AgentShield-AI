/** Customer id used when a request fails before it can be attributed to anyone (bad/forged token). */
export const UNATTRIBUTED_CUSTOMER = 'unattributed';

export type Verdict = 'ALLOW' | 'ASK_CUSTOMER' | 'BLOCK';

export type AgentAction = 'check_balance' | 'pay_bill' | 'transfer' | 'add_payee';

export type ContextProvenance =
  | 'user_instruction'
  | 'tool_output'
  | 'untrusted_document'
  | 'web_content';

export type UserRole = 'customer' | 'bank_admin';

export interface DeviceFingerprint {
  agentRuntimeId: string;
  ip: string;
  asn: string;
  userAgent: string;
}

export interface StageResult {
  stage: number;
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED';
  latencyMs: number;
  summary: string;
  details: Record<string, unknown>;
}

export interface RiskSignal {
  code: string;
  label: string;
  weight: number;
  customerReason: string;
  technicalReason: string;
  matchedSnippet?: string;
}

export interface GatewayExecuteRequest {
  token: string;
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
  sessionId?: string;
  provenance: ContextProvenance;
  contextSnippet?: string;
  nonce: string;
  timestamp: number;
  fingerprint: DeviceFingerprint;
  simulatedHour?: number; // Optional override for deterministic 3 AM testing
  idempotencyKey?: string;
}

export interface Decision {
  requestId: string;
  verdict: Verdict;
  riskScore: number;
  reasons: string[];
  technicalReasons: string[];
  signals: RiskSignal[];
  stageResults: StageResult[];
  latencyMs: number;
  approvalId?: string;
  bankResult?: Record<string, unknown>;
  auditEntryHash?: string;
  revokedProofMs?: number;
  hardBlock?: boolean;
}

export interface GatewaySettings {
  allowMaxScore: number; // default 39 (0-39 ALLOW)
  askMaxScore: number; // default 69 (40-69 ASK_CUSTOMER, 70-100 BLOCK)
  approvalExpiryMinutes: number; // default 10
  rateLimitPerMinute: number; // default 60
  enableLlmJudge: boolean;
  alwaysAskCustomer?: boolean;
  askCustomerOnBlock?: boolean;
  requireRegisteredSession?: boolean;
}
