import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { initSchema } from '../server/db/database.ts';
import { resetAndSeedDatabase } from '../server/db/seed.ts';
import { verifyBankGatewaySecret, getBankInternalSecret } from '../server/bank/bankService.ts';
import { executeGatewayPipeline } from '../server/gateway/pipeline.ts';
import { resolveApproval } from '../server/gateway/stage4_escalation.ts';
import { verifyAuditChain, simulateAuditTampering } from '../server/gateway/stage5_audit.ts';
import { DEFAULT_BILLPAY_FP, issueTokenInDb, runFullSelfTest } from '../server/gateway/selftest.ts';

describe('AgentShield 5-Stage Security Pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    resetAndSeedDatabase(db);
  });

  it('enforces shared internal secret on Mock Bank API', () => {
    expect(verifyBankGatewaySecret(undefined)).toBe(false);
    expect(verifyBankGatewaySecret('wrong-secret')).toBe(false);
    expect(verifyBankGatewaySecret(getBankInternalSecret())).toBe(true);
  });

  it('allows legitimate bill payment matching 30-day baseline in <50ms', async () => {
    const { token } = await issueTokenInDb(db, {
      agentId: 'agent_billpay',
      customerId: 'cust_arjun_sen',
      grantId: 'grant_billpay_main',
      fingerprint: DEFAULT_BILLPAY_FP,
    });

    // Warm up WebCrypto JWT path once before asserting steady-state <50ms latency
    await executeGatewayPipeline(db, {
      token,
      action: 'check_balance',
      params: {},
      intent: 'Check balance',
      provenance: 'user_instruction',
      nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: Date.now(),
      fingerprint: DEFAULT_BILLPAY_FP,
    });

    const decision = await executeGatewayPipeline(db, {
      token,
      action: 'pay_bill',
      params: { payeeId: 'payee_cesc', payeeName: 'CESC Kolkata', category: 'electricity', amount: 1840 },
      intent: 'Pay monthly CESC Kolkata electricity bill',
      provenance: 'user_instruction',
      nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: Date.now(),
      fingerprint: DEFAULT_BILLPAY_FP,
      simulatedHour: 14,
    });

    expect(decision.verdict).toBe('ALLOW');
    expect(decision.riskScore).toBeLessThanOrEqual(39);
    expect(decision.bankResult?.status).toBe('executed');
    expect(decision.latencyMs).toBeLessThan(50);
  });

  it('suspends stolen token on device fingerprint mismatch (Stage 1) until re-issued', async () => {
    const { token, jti } = await issueTokenInDb(db, {
      agentId: 'agent_billpay',
      customerId: 'cust_arjun_sen',
      grantId: 'grant_billpay_main',
      fingerprint: DEFAULT_BILLPAY_FP,
    });

    const d1 = await executeGatewayPipeline(db, {
      token,
      action: 'pay_bill',
      params: { payeeId: 'payee_cesc', payeeName: 'CESC Kolkata', category: 'electricity', amount: 1840 },
      intent: 'Pay bill',
      provenance: 'user_instruction',
      nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: Date.now(),
      fingerprint: { agentRuntimeId: 'attacker', ip: '185.220.101.5', asn: 'AS205100', userAgent: 'curl/8' },
      simulatedHour: 14,
    });

    expect(d1.verdict).toBe('BLOCK');
    const tokRow = db.prepare(`SELECT status FROM tokens WHERE jti = ?`).get(jti) as { status: string };
    expect(tokRow.status).toBe('suspended');

    // Subsequent attempt even from original device stays blocked while suspended
    const d2 = await executeGatewayPipeline(db, {
      token,
      action: 'check_balance',
      params: {},
      intent: 'Check balance',
      provenance: 'user_instruction',
      nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: Date.now(),
      fingerprint: DEFAULT_BILLPAY_FP,
    });
    expect(d2.verdict).toBe('BLOCK');
  });

  it('enforces instant grant revocation on the very next request (Stage 2)', async () => {
    const { token } = await issueTokenInDb(db, {
      agentId: 'agent_billpay',
      customerId: 'cust_arjun_sen',
      grantId: 'grant_billpay_main',
      fingerprint: DEFAULT_BILLPAY_FP,
    });

    const now = Date.now();
    db.prepare(`UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = 'grant_billpay_main'`).run(now - 2);

    const d = await executeGatewayPipeline(
      db,
      {
        token,
        action: 'pay_bill',
        params: { payeeId: 'payee_cesc', payeeName: 'CESC Kolkata', category: 'electricity', amount: 1840 },
        intent: 'Pay monthly electricity bill',
        provenance: 'user_instruction',
        nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
        timestamp: now,
        fingerprint: DEFAULT_BILLPAY_FP,
        simulatedHour: 14,
      },
      { now }
    );

    expect(d.verdict).toBe('BLOCK');
    expect(d.revokedProofMs).toBeGreaterThanOrEqual(1);
  });

  it('escalates 3 AM new payee ₹4,200 to ASK_CUSTOMER and executes idempotently on approval (Stage 3 & 4)', async () => {
    const { token } = await issueTokenInDb(db, {
      agentId: 'agent_billpay',
      customerId: 'cust_arjun_sen',
      grantId: 'grant_billpay_main',
      fingerprint: DEFAULT_BILLPAY_FP,
    });

    const d = await executeGatewayPipeline(db, {
      token,
      action: 'pay_bill',
      params: { payeeId: 'payee_new_solar', payeeName: 'Eastern Solar Grid', category: 'electricity', amount: 4200 },
      intent: 'Pay electricity installation bill',
      provenance: 'user_instruction',
      nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: Date.now(),
      fingerprint: DEFAULT_BILLPAY_FP,
      simulatedHour: 3,
    });

    expect(d.verdict).toBe('ASK_CUSTOMER');
    expect(d.approvalId).toBeTruthy();

    const approved = resolveApproval(db, {
      approvalId: d.approvalId!,
      decision: 'approve',
      pin: '2026',
      customerId: 'cust_arjun_sen',
    });
    expect(approved.status).toBe('approved');
    expect(approved.bankResult?.status).toBe('executed');

    // Second resolve attempt must NOT double-execute
    const second = resolveApproval(db, {
      approvalId: d.approvalId!,
      decision: 'approve',
      customerId: 'cust_arjun_sen',
    });
    expect(second.bankResult).toBeUndefined();
  });

  it('detects database tampering in the SHA-256 + HMAC audit chain (Stage 5)', async () => {
    const clean = verifyAuditChain(db);
    expect(clean.valid).toBe(true);

    const { tamperedIndex } = simulateAuditTampering(db);
    const broken = verifyAuditChain(db);
    expect(broken.valid).toBe(false);
    expect(broken.brokenIndex).toBe(tamperedIndex);
  });

  it('passes all 14 end-to-end self-test scenarios (13/13 non-ALLOW scenarios stopped/escalated)', async () => {
    const report = await runFullSelfTest();
    expect(report.total).toBe(14);
    expect(report.passed).toBe(report.total);
    expect(report.attackScenariosStopped).toBe(report.attackScenariosTotal);
    expect(report.auditChainVerified).toBe(true);
    expect(report.tamperDetectionVerified).toBe(true);
  });
});
