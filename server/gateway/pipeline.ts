import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { UNATTRIBUTED_CUSTOMER, type Decision, type GatewayExecuteRequest, type StageResult, type Verdict } from '../types.ts';
import { BankService } from '../bank/bankService.ts';
import { sha256Hex, signBankExecutionAuth } from './crypto.ts';
import { runStage1Identity } from './stage1_identity.ts';
import { runStage2Delegation } from './stage2_delegation.ts';
import { runStage3Behavior, applyStage3bOutcome, updateBaselineFromApprovedAction, getSettings } from './stage3_behavior.ts';
import { runStage3bLlmJudge, type LlmJudgeFn } from './llmJudge.ts';
import { createPendingApproval } from './stage4_escalation.ts';
import { appendAuditEntry } from './stage5_audit.ts';
import { tryRupeesToPaise } from '../money.ts';

export type GatewayEventEmitter = (eventType: string, payload: unknown) => void;

export async function executeGatewayPipeline(
  db: Database.Database,
  req: GatewayExecuteRequest,
  options?: {
    now?: number;
    emitEvent?: GatewayEventEmitter;
    skipBankExecution?: boolean;
    llmJudgeFn?: LlmJudgeFn;
    disableLlmJudge?: boolean;
  }
): Promise<Decision> {
  const tStart = performance.now();
  const now = options?.now ?? Date.now();
  const requestId = `req_${crypto.randomBytes(5).toString('hex')}`;
  const stageResults: StageResult[] = [];
  const emit = options?.emitEvent;

  const amountPaiseForReq = tryRupeesToPaise(req.params.amount ?? 0) ?? 0;

  const payloadHash = sha256Hex(
    JSON.stringify({
      action: req.action,
      params: req.params,
      amountPaise: amountPaiseForReq,
      intent: req.intent,
      provenance: req.provenance,
    })
  );

  let agentId = 'unknown';
  let customerId = UNATTRIBUTED_CUSTOMER;
  let grantId = 'unknown';
  let verdict: Verdict = 'BLOCK';
  let riskScore = 100;
  let reasons: string[] = [];
  let technicalReasons: string[] = [];
  let signals: Decision['signals'] = [];
  let approvalId: string | undefined;
  let bankResult: Record<string, unknown> | undefined;
  let revokedProofMs: number | undefined;
  let hardBlock = false;
  let threatType = 'nominal';

  try {
    // Stage 1: Identity & Token Binding
    const s1 = await runStage1Identity(db, req, now);
    stageResults.push(s1.stageResult);
    agentId = s1.agentId;
    customerId = s1.customerId;
    grantId = s1.grantId;

    if (!s1.passed) {
      hardBlock = true;
      verdict = 'BLOCK';
      riskScore = s1.threatType === 'stolen_token' ? 98 : 90;
      reasons = [s1.customerReason || 'Agent authentication failed'];
      technicalReasons = [s1.technicalReason || 'Stage 1 blocked request'];
      threatType = s1.threatType || 'identity_failure';

      stageResults.push(
        { stage: 2, name: 'Scoped Delegation', status: 'SKIPPED', latencyMs: 0, summary: 'Skipped after Stage 1 block', details: {} },
        { stage: 3, name: 'Behaviour & Intent Engine', status: 'SKIPPED', latencyMs: 0, summary: 'Skipped after Stage 1 block', details: {} },
        { stage: 4, name: 'Human Escalation', status: 'SKIPPED', latencyMs: 0, summary: 'Skipped on hard block', details: {} }
      );
    } else {
      // Stage 2: Scoped Delegation
      const s2 = runStage2Delegation(db, req, { agentId, customerId, grantId }, now);
      stageResults.push(s2.stageResult);

      if (!s2.passed) {
        hardBlock = true;
        verdict = 'BLOCK';
        riskScore = 88;
        reasons = [s2.customerReason || 'Action outside delegated permissions'];
        technicalReasons = [s2.technicalReason || 'Stage 2 blocked request'];
        revokedProofMs = s2.revokedProofMs;
        threatType = s2.threatType || 'delegation_violation';

        stageResults.push(
          { stage: 3, name: 'Behaviour & Intent Engine', status: 'SKIPPED', latencyMs: 0, summary: 'Skipped after Stage 2 block', details: {} },
          { stage: 4, name: 'Human Escalation', status: 'SKIPPED', latencyMs: 0, summary: 'Skipped on hard block', details: {} }
        );
      } else {
        // Stage 3: Behavioural Anomaly, Intent & Provenance
        const s3Rules = runStage3Behavior(db, req, { agentId, customerId, grant: s2.grant }, now);
        stageResults.push(s3Rules.stageResult);

        const settings = getSettings(db);
        let s3 = s3Rules;
        const shouldInvokeJudge =
          !options?.disableLlmJudge &&
          (req.action === 'pay_bill' || req.action === 'transfer' || req.action === 'add_payee' || Boolean(req.contextSnippet?.trim()));

        if (shouldInvokeJudge) {
          const regIntent = (s3Rules.stageResult.details.registeredSessionIntent as string | null) ?? null;
          const s3b = await runStage3bLlmJudge(
            req,
            {
              enabled: settings.enableLlmJudge,
              registeredSessionIntent: regIntent,
              ruleVerdict: s3Rules.verdict,
            },
            { llmJudgeFn: options?.llmJudgeFn, now }
          );
          stageResults.push(s3b.stageResult);
          s3 = applyStage3bOutcome(s3Rules, req, settings, s3b);
        }

        verdict = s3.verdict;
        riskScore = s3.riskScore;
        reasons = s3.customerReasons;
        technicalReasons = s3.technicalReasons;
        signals = s3.signals;
        threatType = s3.threatType;

        if (verdict === 'ALLOW') {
          stageResults.push({
            stage: 4,
            name: 'Human Escalation',
            status: 'SKIPPED',
            latencyMs: 0,
            summary: 'Risk below threshold; no customer prompt needed',
            details: {},
          });

          if (!options?.skipBankExecution) {
            const idemKey = req.idempotencyKey || `idem_${requestId}`;
            const verifiedAmountPaise = s2.amountPaise ?? 0;
            const gatewayAuth = signBankExecutionAuth(
              {
                requestId,
                customerId,
                agentId,
                action: req.action,
                amountPaise: req.action === 'pay_bill' || req.action === 'transfer' ? verifiedAmountPaise : 0,
                payeeId: req.params.payeeId ?? null,
                idempotencyKey: idemKey,
              },
              30_000,
              now
            );

            const bank = new BankService(db);
            bankResult = bank.executeAuthorizedAction({
              customerId,
              agentId,
              action: req.action,
              accountId: req.params.accountId,
              payeeId: req.params.payeeId,
              payeeName: req.params.payeeName,
              payeeVpa: req.params.payeeVpa,
              category: req.params.category,
              amountPaise: req.action === 'pay_bill' || req.action === 'transfer' ? verifiedAmountPaise : undefined,
              note: req.params.note,
              idempotencyKey: idemKey,
              gatewayAuth,
              requireGatewayAuth: true,
            });
            updateBaselineFromApprovedAction(db, agentId, customerId, req, now);
          }
        } else if (verdict === 'ASK_CUSTOMER') {
          persistRequestRow(db, { requestId, agentId, customerId, grantId, req, amountPaise: amountPaiseForReq, payloadHash, now });
          const s4 = createPendingApproval(db, { requestId, customerId, agentId, req, riskScore, reasons }, now);
          stageResults.push(s4.stageResult);
          approvalId = s4.approval.id;
          emit?.('approval:created', { ...s4.approval, action_payload: undefined });
        } else {
          stageResults.push({
            stage: 4,
            name: 'Human Escalation',
            status: 'SKIPPED',
            latencyMs: 0,
            summary: 'Blocked autonomously by risk threshold',
            details: {},
          });
        }
      }
    }
  } catch (err) {
    // FAIL CLOSED: any unexpected pipeline error forces BLOCK and logs
    hardBlock = true;
    verdict = 'BLOCK';
    riskScore = 100;
    const msg = err instanceof Error ? err.message : 'Internal gateway fault';
    reasons = ['Security gateway failed closed due to an unexpected error.'];
    technicalReasons = [`Fail-closed block: ${msg}`];
    threatType = 'fail_closed';
    stageResults.push({
      stage: stageResults.length + 1,
      name: 'Fail-Closed Guard',
      status: 'FAIL',
      latencyMs: 0.1,
      summary: msg,
      details: { failClosed: true },
    });
  }

  const existingReq = db.prepare(`SELECT id FROM requests WHERE id = ?`).get(requestId);
  if (!existingReq) {
    persistRequestRow(db, { requestId, agentId, customerId, grantId, req, amountPaise: amountPaiseForReq, payloadHash, now });
  }

  // Optional: when customer enabled ask_customer_on_block, escalate blocked payment for hazardous approve/deny
  if (
    verdict === 'BLOCK' &&
    !approvalId &&
    customerId !== UNATTRIBUTED_CUSTOMER &&
    (req.action === 'pay_bill' || req.action === 'transfer' || req.action === 'add_payee') &&
    getSettings(db).askCustomerOnBlock
  ) {
    const s4Override = createPendingApproval(
      db,
      { requestId, customerId, agentId, req, riskScore, reasons, isHazardous: true },
      now
    );
    approvalId = s4Override.approval.id;
    emit?.('approval:created', { ...s4Override.approval, action_payload: undefined });
  }

  // Stage 5: Tamper-evident audit chain
  let s5: { entryHash: string; stageResult: StageResult };
  try {
    s5 = appendAuditEntry(
      db,
      {
        requestId,
        agentId,
        customerId,
        action: req.action,
        payloadHash,
        decision: verdict,
        riskScore,
        reasons,
        stageResults,
      },
      now
    );
  } catch (err) {
    console.error('[agentshield] CRITICAL: audit append failed', requestId, err);
    s5 = {
      entryHash: 'audit_append_failed',
      stageResult: {
        stage: 5,
        name: 'Tamper-Evident Audit',
        status: 'FAIL',
        latencyMs: 0,
        summary: 'Audit append failed; request flagged for operator review',
        details: { requestId },
      },
    };
  }
  stageResults.push(s5.stageResult);

  const latencyMs = Number((performance.now() - tStart).toFixed(2));

  db.prepare(
    `INSERT INTO decisions (id, request_id, verdict, risk_score, reasons, technical_reasons, signals, stage_results, latency_ms, hard_block, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `dec_${crypto.randomBytes(5).toString('hex')}`,
    requestId,
    verdict,
    riskScore,
    JSON.stringify(reasons),
    JSON.stringify(technicalReasons),
    JSON.stringify(signals),
    JSON.stringify(stageResults),
    latencyMs,
    hardBlock ? 1 : 0,
    now
  );

  // Create alert on high-severity blocks if not already created by Stage 1
  if (verdict === 'BLOCK' && threatType !== 'stolen_token' && signals.some((s) => s.code === 'PROMPT_INJECTION' || s.code === 'INTENT_MISMATCH')) {
    const alertId = `alert_${crypto.randomBytes(4).toString('hex')}`;
    const title = signals.some((s) => s.code === 'PROMPT_INJECTION')
      ? 'Prompt Injection Attack Blocked'
      : 'Agent Intent Mismatch Blocked';
    db.prepare(
      `INSERT INTO alerts (id, customer_id, agent_id, severity, threat_type, title, message, acknowledged, created_at) VALUES (?, ?, ?, 'critical', ?, ?, ?, 0, ?)`
    ).run(alertId, customerId, agentId, threatType, title, reasons[0] || technicalReasons[0], now);
    emit?.('alert:created', { id: alertId, customerId, agentId, severity: 'critical', threatType, title, message: reasons[0], createdAt: now });
  }

  const decision: Decision = {
    requestId,
    verdict,
    riskScore,
    reasons,
    technicalReasons,
    signals,
    stageResults,
    latencyMs,
    approvalId,
    bankResult,
    auditEntryHash: s5.entryHash,
    revokedProofMs,
    hardBlock,
  };

  emit?.('gateway:decision', {
    ...decision,
    agentId,
    customerId,
    action: req.action,
    amount: req.params.amount ?? 0,
    payeeName: req.params.payeeName || req.params.payeeVpa || req.action,
    threatType,
    timestamp: now,
  });

  return decision;
}

function persistRequestRow(
  db: Database.Database,
  params: {
    requestId: string;
    agentId: string;
    customerId: string;
    grantId: string;
    req: GatewayExecuteRequest;
    amountPaise: number;
    payloadHash: string;
    now: number;
  }
): void {
  const { requestId, agentId, customerId, grantId, req, amountPaise, payloadHash, now } = params;
  db.prepare(
    `INSERT INTO requests (id, agent_id, customer_id, grant_id, session_id, action, category, payee_id, payee_name, amount, stated_intent, provenance, context_snippet, idempotency_key, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    requestId,
    agentId,
    customerId,
    grantId,
    req.sessionId ?? null,
    req.action,
    req.params.category ?? null,
    req.params.payeeId ?? null,
    req.params.payeeName ?? req.params.payeeVpa ?? null,
    amountPaise,
    req.intent,
    req.provenance,
    req.contextSnippet ?? null,
    req.idempotencyKey ?? null,
    payloadHash,
    now
  );
}
