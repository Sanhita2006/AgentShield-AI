import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { GatewayExecuteRequest, StageResult } from '../types.ts';
import { BankService } from '../bank/bankService.ts';
import { getSettings, resolveEffectiveHour, updateBaselineFromApprovedAction } from './stage3_behavior.ts';
import { signBankExecutionAuth, verifySecret } from './crypto.ts';
import { runStage2Delegation } from './stage2_delegation.ts';
import { appendLifecycleAudit } from './stage5_audit.ts';
import { formatInrFromPaise, paiseToRupees, tryRupeesToPaise } from '../money.ts';
import { formatHour12 } from '../time.ts';

const MAX_PIN_ATTEMPTS = 5;
const pinFailures = new Map<string, number>();
const CUSTOMER_PIN_WINDOW_MS = 15 * 60_000;
const CUSTOMER_PIN_MAX_FAILURES = 10;
const customerPinFailures = new Map<string, number[]>();

function recentCustomerPinFailures(customerId: string, now: number): number[] {
  const recent = (customerPinFailures.get(customerId) ?? []).filter((t) => t > now - CUSTOMER_PIN_WINDOW_MS);
  customerPinFailures.set(customerId, recent);
  return recent;
}

/** Test/demo helper: forget all PIN failure history. */
export function resetPinThrottle(): void {
  pinFailures.clear();
  customerPinFailures.clear();
}

/** Thrown for caller mistakes (wrong PIN, wrong owner) so routes can map them to 4xx. */
export class ApprovalError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 | 423 = 400) {
    super(message);
  }
}

export interface ApprovalRecord {
  id: string;
  request_id: string;
  customer_id: string;
  agent_id: string;
  summary: string;
  reasons: string;
  risk_score: number;
  action_payload: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  is_hazardous: number;
  expires_at: number;
  resolved_at: number | null;
  created_at: number;
}

export function createPendingApproval(
  db: Database.Database,
  params: {
    requestId: string;
    customerId: string;
    agentId: string;
    req: GatewayExecuteRequest;
    riskScore: number;
    reasons: string[];
    isHazardous?: boolean;
  },
  now: number = Date.now()
): { approval: ApprovalRecord; stageResult: StageResult } {
  const t0 = performance.now();
  const existing = db.prepare(`SELECT * FROM approvals WHERE request_id = ?`).get(params.requestId) as ApprovalRecord | undefined;
  if (existing) {
    return {
      approval: existing,
      stageResult: {
        stage: 4,
        name: 'Human Escalation',
        status: 'WARN',
        latencyMs: Number((performance.now() - t0).toFixed(2)),
        summary: `Escalated to customer (${existing.id}); held awaiting approval`,
        details: { approvalId: existing.id, expiresAt: existing.expires_at, summary: existing.summary, isHazardous: Boolean(existing.is_hazardous) },
      },
    };
  }

  const settings = getSettings(db);
  const agentRow = db.prepare(`SELECT name FROM agents WHERE id = ?`).get(params.agentId) as { name: string } | undefined;
  const agentName = agentRow?.name || params.agentId;

  const amountPaise = tryRupeesToPaise(params.req.params.amount ?? 0) ?? 0;
  const amountStr = amountPaise > 0 ? formatInrFromPaise(amountPaise) : '';
  const targetName = params.req.params.payeeName || params.req.params.payeeVpa || 'an unrecognized payee';
  const targetStr = params.req.params.payeeVpa && params.req.params.payeeName ? `${targetName} (UPI: ${params.req.params.payeeVpa})` : targetName;
  const hour = resolveEffectiveHour(db, params.customerId, now, params.req.simulatedHour);
  const timeStr = formatHour12(hour);

  const baseSummary =
    params.req.action === 'pay_bill' || params.req.action === 'transfer'
      ? `${agentName} wants to pay ${amountStr} to ${targetStr} at ${timeStr}`
      : `${agentName} requests approval for ${params.req.action}`;

  const summary = params.isHazardous ? `[BLOCKED PAYMENT OVERRIDE] ${baseSummary}` : baseSummary;

  const approvalId = `appr_${crypto.randomBytes(5).toString('hex')}`;
  const expiresAt = now + settings.approvalExpiryMinutes * 60_000;

  db.prepare(
    `INSERT INTO approvals (id, request_id, customer_id, agent_id, summary, reasons, risk_score, action_payload, status, is_hazardous, expires_at, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?)`
  ).run(
    approvalId,
    params.requestId,
    params.customerId,
    params.agentId,
    summary,
    JSON.stringify(params.reasons),
    params.riskScore,
    JSON.stringify({ ...params.req, token: '[redacted]', _hazardousOverride: Boolean(params.isHazardous), _amountPaise: amountPaise }),
    params.isHazardous ? 1 : 0,
    expiresAt,
    now
  );

  appendLifecycleAudit(
    db,
    {
      entityId: approvalId,
      agentId: params.agentId,
      customerId: params.customerId,
      action: 'approval_created',
      decision: 'ASK_CUSTOMER',
      riskScore: params.riskScore,
      details: {
        approvalId,
        requestId: params.requestId,
        amountPaise,
        payeeId: params.req.params.payeeId ?? null,
        isHazardous: Boolean(params.isHazardous),
        expiresAt,
      },
      summary: `Approval ${approvalId} created (${summary})`,
    },
    now
  );

  const approval = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(approvalId) as ApprovalRecord;

  return {
    approval,
    stageResult: {
      stage: 4,
      name: 'Human Escalation',
      status: 'WARN',
      latencyMs: Number((performance.now() - t0).toFixed(2)),
      summary: `Escalated to customer (${approvalId}); held awaiting approval`,
      details: { approvalId, expiresAt, summary, isHazardous: Boolean(params.isHazardous) },
    },
  };
}

export function createHazardousOverrideFromRequest(
  db: Database.Database,
  requestId: string,
  customerId: string,
  now: number = Date.now()
): ApprovalRecord {
  const reqRow = db
    .prepare(`SELECT * FROM requests WHERE id = ? AND customer_id = ?`)
    .get(requestId, customerId) as
    | {
        id: string;
        agent_id: string;
        customer_id: string;
        action: GatewayExecuteRequest['action'];
        category: string | null;
        payee_id: string | null;
        payee_name: string | null;
        amount: number; // stored in integer paise
        stated_intent: string | null;
        provenance: GatewayExecuteRequest['provenance'];
        context_snippet: string | null;
        idempotency_key: string | null;
      }
    | undefined;

  if (!reqRow) {
    throw new ApprovalError('Blocked request not found for this customer', 404);
  }
  if (reqRow.action !== 'pay_bill' && reqRow.action !== 'transfer' && reqRow.action !== 'add_payee') {
    throw new ApprovalError('Only payment or payee requests can be escalated for override', 400);
  }

  const decRow = db
    .prepare(`SELECT verdict, risk_score, reasons FROM decisions WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(requestId) as { verdict: string; risk_score: number; reasons: string } | undefined;

  const reasons = decRow ? (JSON.parse(decRow.reasons || '[]') as string[]) : ['Blocked by AgentShield security gateway'];
  const riskScore = decRow ? Number(decRow.risk_score) : 90;

  const syntheticReq: GatewayExecuteRequest = {
    token: '[redacted]',
    action: reqRow.action,
    params: {
      payeeId: reqRow.payee_id ?? undefined,
      payeeName: reqRow.payee_name ?? undefined,
      category: reqRow.category ?? undefined,
      amount: paiseToRupees(Number(reqRow.amount ?? 0)),
      note: `Hazardous customer override for blocked request ${requestId}`,
    },
    intent: reqRow.stated_intent || 'Blocked payment escalated for customer override',
    provenance: reqRow.provenance,
    contextSnippet: reqRow.context_snippet ?? undefined,
    nonce: `override_${requestId}`,
    timestamp: now,
    fingerprint: { agentRuntimeId: 'override', ip: '0.0.0.0', asn: 'OVERRIDE', userAgent: 'CustomerOverride' },
    idempotencyKey: reqRow.idempotency_key ?? undefined,
  };

  const { approval } = createPendingApproval(
    db,
    {
      requestId,
      customerId,
      agentId: reqRow.agent_id,
      req: syntheticReq,
      riskScore,
      reasons,
      isHazardous: true,
    },
    now
  );

  return approval;
}

export function resolveApproval(
  db: Database.Database,
  params: {
    approvalId: string;
    decision: 'approve' | 'deny';
    pin?: string;
    customerId: string;
    trustPayee?: boolean;
  },
  now: number = Date.now()
): { status: 'approved' | 'denied' | 'expired'; approval: ApprovalRecord; bankResult?: Record<string, unknown> } {
  const approval = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(params.approvalId) as ApprovalRecord | undefined;
  if (!approval || approval.customer_id !== params.customerId) {
    throw new ApprovalError('Approval record not found', 404);
  }

  if (approval.status !== 'pending') {
    return { status: approval.status, approval };
  }

  if (now > approval.expires_at) {
    db.prepare(`UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ?`).run(now, approval.id);
    appendLifecycleAudit(
      db,
      {
        entityId: approval.id,
        agentId: approval.agent_id,
        customerId: approval.customer_id,
        action: 'approval_expired',
        decision: 'BLOCK',
        riskScore: approval.risk_score,
        details: { approvalId: approval.id, requestId: approval.request_id, expiredAt: approval.expires_at },
        summary: `Approval ${approval.id} expired without customer response`,
      },
      now
    );
    const updated = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(approval.id) as ApprovalRecord;
    return { status: 'expired', approval: updated };
  }

  if (params.decision === 'approve') {
    const failures = pinFailures.get(approval.id) ?? 0;
    if (failures >= MAX_PIN_ATTEMPTS) {
      throw new ApprovalError('Too many wrong PIN attempts. Approve is locked; deny or let it expire.', 423);
    }
    if (recentCustomerPinFailures(approval.customer_id, now).length >= CUSTOMER_PIN_MAX_FAILURES) {
      throw new ApprovalError('Too many wrong PIN attempts on your account. Try again in 15 minutes.', 423);
    }
    const customer = db.prepare(`SELECT pin_hash FROM customers WHERE id = ?`).get(approval.customer_id) as
      | { pin_hash: string }
      | undefined;
    if (!customer || !params.pin || !verifySecret(params.pin, customer.pin_hash)) {
      pinFailures.set(approval.id, failures + 1);
      recentCustomerPinFailures(approval.customer_id, now).push(now);
      const left = MAX_PIN_ATTEMPTS - failures - 1;
      throw new ApprovalError(`Invalid customer PIN for step-up approval (${Math.max(0, left)} attempts left)`, 403);
    }
    pinFailures.delete(approval.id);
    customerPinFailures.delete(approval.customer_id);
  }

  if (params.decision === 'deny') {
    db.prepare(`UPDATE approvals SET status = 'denied', resolved_at = ? WHERE id = ?`).run(now, approval.id);
    pinFailures.delete(approval.id);
    appendLifecycleAudit(
      db,
      {
        entityId: approval.id,
        agentId: approval.agent_id,
        customerId: approval.customer_id,
        action: 'approval_denied',
        decision: 'BLOCK',
        riskScore: approval.risk_score,
        details: { approvalId: approval.id, requestId: approval.request_id },
        summary: `Customer denied escalated request (${approval.id})`,
      },
      now
    );
    const updated = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(approval.id) as ApprovalRecord;
    return { status: 'denied', approval: updated };
  }

  const reqPayload = JSON.parse(approval.action_payload) as GatewayExecuteRequest & {
    _hazardousOverride?: boolean;
    _amountPaise?: number;
  };
  const isHazardous = Boolean(approval.is_hazardous || reqPayload._hazardousOverride);
  const amountPaise =
    reqPayload._amountPaise !== undefined
      ? reqPayload._amountPaise
      : tryRupeesToPaise(reqPayload.params.amount ?? 0) ?? 0;

  if (!isHazardous) {
    const grantRow = db.prepare(`SELECT grant_id FROM requests WHERE id = ?`).get(approval.request_id) as
      | { grant_id: string | null }
      | undefined;
    const agentRow = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(approval.agent_id) as { status: string } | undefined;
    const recheck =
      agentRow?.status === 'active'
        ? runStage2Delegation(
            db,
            { ...reqPayload, simulatedHour: undefined },
            { agentId: approval.agent_id, customerId: approval.customer_id, grantId: grantRow?.grant_id ?? 'unknown' },
            now
          )
        : null;
    if (!recheck || !recheck.passed) {
      db.prepare(`UPDATE approvals SET status = 'denied', resolved_at = ? WHERE id = ?`).run(now, approval.id);
      const why = recheck ? recheck.customerReason || recheck.technicalReason : 'The agent is no longer active.';
      appendLifecycleAudit(
        db,
        {
          entityId: approval.id,
          agentId: approval.agent_id,
          customerId: approval.customer_id,
          action: 'approval_denied',
          decision: 'BLOCK',
          riskScore: approval.risk_score,
          details: { approvalId: approval.id, requestId: approval.request_id, reason: why },
          summary: `Approval ${approval.id} cancelled on settlement re-check: ${why}`,
        },
        now
      );
      throw new ApprovalError(`This request can no longer be approved and was cancelled. ${why}`, 409);
    }
  }

  const idemKey = reqPayload.idempotencyKey || `idem_appr_${approval.id}`;
  const gatewayAuth = signBankExecutionAuth(
    {
      requestId: approval.request_id,
      customerId: approval.customer_id,
      agentId: approval.agent_id,
      action: reqPayload.action,
      amountPaise: reqPayload.action === 'pay_bill' || reqPayload.action === 'transfer' ? amountPaise : 0,
      payeeId: reqPayload.params.payeeId ?? null,
      idempotencyKey: idemKey,
    },
    30_000,
    now
  );

  const bank = new BankService(db);
  const bankResult = db.transaction(() => {
    const result = bank.executeAuthorizedAction({
      customerId: approval.customer_id,
      agentId: approval.agent_id,
      action: reqPayload.action,
      accountId: reqPayload.params.accountId,
      payeeId: reqPayload.params.payeeId,
      payeeName: reqPayload.params.payeeName,
      payeeVpa: reqPayload.params.payeeVpa,
      category: reqPayload.params.category,
      amountPaise: reqPayload.action === 'pay_bill' || reqPayload.action === 'transfer' ? amountPaise : undefined,
      note:
        reqPayload.params.note ||
        (isHazardous
          ? `HAZARDOUS OVERRIDE approved by customer (${approval.id})`
          : `One-time customer approved (${approval.id})`),
      idempotencyKey: idemKey,
      gatewayAuth,
      requireGatewayAuth: true,
    });
    db.prepare(`UPDATE approvals SET status = 'approved', resolved_at = ? WHERE id = ?`).run(now, approval.id);
    return result;
  })();

  if (!isHazardous) {
    updateBaselineFromApprovedAction(db, approval.agent_id, approval.customer_id, reqPayload, now, {
      trustPayee: params.trustPayee === true,
    });
  }

  appendLifecycleAudit(
    db,
    {
      entityId: approval.id,
      agentId: approval.agent_id,
      customerId: approval.customer_id,
      action: 'approval_approved',
      decision: 'ALLOW',
      riskScore: approval.risk_score,
      details: {
        approvalId: approval.id,
        requestId: approval.request_id,
        amountPaise,
        payeeId: reqPayload.params.payeeId ?? null,
        hazardousOverride: isHazardous,
        trustPayee: params.trustPayee === true,
      },
      summary: isHazardous
        ? `Customer explicitly approved blocked payment after HIGHLY HAZARDOUS warning and PIN verification (${approval.id})`
        : `Customer approved escalated payment (${approval.id})`,
    },
    now
  );

  const updated = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(approval.id) as ApprovalRecord;
  return { status: 'approved', approval: updated, bankResult };
}

/** Marks every pending approval past its deadline as expired. Returns the ones it changed. */
export function expirePendingApprovals(db: Database.Database, now: number = Date.now()): ApprovalRecord[] {
  const due = db
    .prepare(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at < ?`)
    .all(now) as ApprovalRecord[];
  if (due.length) {
    db.prepare(`UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at < ?`).run(now, now);
    for (const a of due) {
      appendLifecycleAudit(
        db,
        {
          entityId: a.id,
          agentId: a.agent_id,
          customerId: a.customer_id,
          action: 'approval_expired',
          decision: 'BLOCK',
          riskScore: a.risk_score,
          details: { approvalId: a.id, requestId: a.request_id, expiredAt: a.expires_at },
          summary: `Approval ${a.id} expired past deadline`,
        },
        now
      );
    }
  }
  return due;
}
