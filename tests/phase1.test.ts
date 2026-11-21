import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import crypto from 'node:crypto';
import { initSchema, setDbForTest } from '../server/db/database.ts';
import { resetAndSeedDatabase } from '../server/db/seed.ts';
import { tryRupeesToPaise, rupeesToPaise, paiseToRupees, formatInrFromPaise } from '../server/money.ts';
import { getHourInTimezone } from '../server/time.ts';
import { executeGatewayPipeline } from '../server/gateway/pipeline.ts';
import { resolveApproval } from '../server/gateway/stage4_escalation.ts';
import { exportAuditAnchor, verifyAuditAgainstAnchor, verifyAuditChain } from '../server/gateway/stage5_audit.ts';
import { DEFAULT_BILLPAY_FP, issueTokenInDb } from '../server/gateway/selftest.ts';
import { signBankExecutionAuth, verifyBankExecutionAuth } from '../server/gateway/crypto.ts';
import { BankService, getBankInternalSecret } from '../server/bank/bankService.ts';
import { createApp } from '../server/app.ts';

const CUSTOMER = { email: 'arjun.sen@example.in', password: 'arjun2026' };
const nonce = () => `nonce_${crypto.randomBytes(6).toString('hex')}`;

let db: Database.Database;
const savedEnv = { ...process.env };

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  resetAndSeedDatabase(db);
  setDbForTest(db);
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('Phase 1.1: integer paise money handling & migration', () => {
  it('converts floating-point rupee inputs to exact integer paise without drift (0.1 + 0.2, 4999.99)', () => {
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(paiseToRupees(10 + 20)).toBe(0.3);
    expect(rupeesToPaise(4999.99)).toBe(499999);
    expect(tryRupeesToPaise(100.123)).toBeNull();
    expect(formatInrFromPaise(14250030)).toContain('1,42,500.30');
  });

  it('prevents float drift across bank balance debits and Stage 2 daily totals', async () => {
    const { token } = await issueTokenInDb(db, {
      agentId: 'agent_billpay',
      customerId: 'cust_arjun_sen',
      grantId: 'grant_billpay_main',
      fingerprint: DEFAULT_BILLPAY_FP,
    });

    const d = await executeGatewayPipeline(db, {
      token,
      action: 'pay_bill',
      params: { payeeId: 'payee_cesc', payeeName: 'CESC Kolkata', category: 'electricity', amount: 1840.3 },
      intent: 'Pay monthly CESC Kolkata electricity bill',
      provenance: 'user_instruction',
      nonce: nonce(),
      timestamp: Date.now(),
      fingerprint: DEFAULT_BILLPAY_FP,
      simulatedHour: 14,
    });

    expect(d.verdict).toBe('ALLOW');
    expect(d.bankResult?.amountPaise).toBe(184030);
    expect(d.bankResult?.newBalancePaise).toBe(14250000 - 184030);

    const acc = db.prepare(`SELECT balance FROM accounts WHERE id = 'acc_indb_7841'`).get() as { balance: number };
    expect(acc.balance).toBe(14065970);
  });

  it('migrates legacy rupee-unit databases cleanly to integer paise in initSchema()', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, city TEXT, pin_hash TEXT, created_at INTEGER);
      CREATE TABLE accounts (id TEXT PRIMARY KEY, customer_id TEXT, account_number TEXT, account_type TEXT, currency TEXT DEFAULT 'INR', balance REAL, updated_at INTEGER);
      CREATE TABLE payees (id TEXT PRIMARY KEY, customer_id TEXT, name TEXT, vpa TEXT, category TEXT, verified INTEGER DEFAULT 1, created_at INTEGER);
      CREATE TABLE grants (id TEXT PRIMARY KEY, customer_id TEXT, agent_id TEXT, title TEXT, allowed_actions TEXT, allowed_categories TEXT, payee_allowlist TEXT, per_txn_limit REAL, daily_limit REAL, monthly_limit REAL, valid_from INTEGER, valid_until INTEGER, allowed_hours TEXT, status TEXT, revoked_at INTEGER, created_at INTEGER);
      CREATE TABLE transactions (id TEXT PRIMARY KEY, account_id TEXT, customer_id TEXT, agent_id TEXT, payee_id TEXT, payee_name TEXT, category TEXT, action TEXT, amount REAL, status TEXT, idempotency_key TEXT UNIQUE, note TEXT, created_at INTEGER);
      CREATE TABLE baselines (agent_id TEXT PRIMARY KEY, customer_id TEXT, typical_amount_mean REAL, typical_amount_std REAL, txn_count INTEGER, typical_hours TEXT, known_payees TEXT, updated_at INTEGER);
      CREATE TABLE requests (id TEXT PRIMARY KEY, request_id TEXT UNIQUE, agent_id TEXT, customer_id TEXT, grant_id TEXT, action TEXT, payee_id TEXT, payee_name TEXT, category TEXT, amount REAL, stated_intent TEXT, provenance TEXT, action_payload TEXT, risk_score INTEGER, verdict TEXT, reasons TEXT, technical_reasons TEXT, stage_results TEXT, approval_id TEXT, latency_ms INTEGER, created_at INTEGER);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE tokens (jti TEXT PRIMARY KEY, agent_id TEXT, customer_id TEXT, grant_id TEXT, fingerprint_hash TEXT, issued_at INTEGER, expires_at INTEGER, status TEXT CHECK (status IN ('active', 'revoked', 'compromised')));
    `);
    const now = Date.now();
    legacy.prepare(`INSERT INTO customers VALUES ('c1', 'Legacy User', 'legacy@example.in', 'Kolkata', 'hash', ?)`).run(now);
    legacy.prepare(`INSERT INTO accounts VALUES ('a1', 'c1', 'XX01', 'savings', 'INR', 4999.99, ?)`).run(now);
    legacy.prepare(`INSERT INTO grants VALUES ('g1', 'c1', 'ag1', 'Legacy', '["pay_bill"]', '["electricity"]', '[]', 5000, 10000, 25000, ?, ?, NULL, 'active', NULL, ?)`).run(now, now + 10000, now);
    legacy.prepare(`INSERT INTO transactions VALUES ('t1', 'a1', 'c1', 'ag1', 'p1', 'CESC', 'electricity', 'pay_bill', 1840.25, 'completed', 'k1', 'n', ?)`).run(now);
    legacy.prepare(`INSERT INTO baselines VALUES ('ag1', 'c1', 1500.5, 250.25, 5, '[14]', '["p1"]', ?)`).run(now);

    initSchema(legacy);

    const acc = legacy.prepare(`SELECT balance FROM accounts WHERE id = 'a1'`).get() as { balance: number };
    const grant = legacy.prepare(`SELECT per_txn_limit FROM grants WHERE id = 'g1'`).get() as { per_txn_limit: number };
    const txn = legacy.prepare(`SELECT amount FROM transactions WHERE id = 't1'`).get() as { amount: number };
    const base = legacy.prepare(`SELECT typical_amount_mean, typical_amount_std FROM baselines WHERE agent_id = 'ag1'`).get() as {
      typical_amount_mean: number;
      typical_amount_std: number;
    };
    const meta = legacy.prepare(`SELECT value FROM settings WHERE key = 'money_unit'`).get() as { value: string };

    expect(acc.balance).toBe(499999);
    expect(grant.per_txn_limit).toBe(500000);
    expect(txn.amount).toBe(184025);
    expect(base.typical_amount_mean).toBe(150050);
    expect(base.typical_amount_std).toBe(25025);
    expect(meta.value).toBe('paise');
  });
});

describe('Phase 1.2: customer-timezone evaluation', () => {
  it('resolves 03:00 IST from UTC timestamp regardless of server TZ and ignores simulatedHour outside DEMO_MODE', async () => {
    // 2026-11-20T21:30:00Z is exactly 03:00 IST (UTC+5:30)
    const utcTimestampFor3AmIst = Date.UTC(2026, 10, 20, 21, 30, 0);
    expect(getHourInTimezone(utcTimestampFor3AmIst, 'Asia/Kolkata')).toBe(3);

    process.env.DEMO_MODE = 'false';
    // Issue token valid at utcTimestampFor3AmIst (JWT uses Date.now()-based exp unless ttl covers offset)
    const { token } = await issueTokenInDb(db, {
      agentId: 'agent_billpay',
      customerId: 'cust_arjun_sen',
      grantId: 'grant_billpay_main',
      fingerprint: DEFAULT_BILLPAY_FP,
      ttlSeconds: 86400,
    });

    // Even if agent sends simulatedHour=14, in production mode the server inspects customer timezone (3 AM IST -> UNUSUAL_HOUR)
    const d = await executeGatewayPipeline(
      db,
      {
        token,
        action: 'pay_bill',
        params: { payeeId: 'payee_cesc', payeeName: 'CESC Kolkata', category: 'electricity', amount: 1840 },
        intent: 'Pay monthly electricity bill',
        provenance: 'user_instruction',
        nonce: nonce(),
        timestamp: utcTimestampFor3AmIst,
        fingerprint: DEFAULT_BILLPAY_FP,
        simulatedHour: 14,
      },
      { now: utcTimestampFor3AmIst }
    );

    expect(d.signals.some((s) => s.code === 'UNUSUAL_HOUR')).toBe(true);
  });
});

describe('Phase 1.3: token suspension instead of burn griefing & alert rate limit', () => {
  it('suspends token on fingerprint mismatch, rate-limits alerts, and allows explicit customer re-issue', async () => {
    process.env.DEMO_MODE = 'false';
    const app = createApp();
    const { token, jti } = await issueTokenInDb(db, {
      agentId: 'agent_billpay',
      customerId: 'cust_arjun_sen',
      grantId: 'grant_billpay_main',
      fingerprint: DEFAULT_BILLPAY_FP,
    });

    // Flood 5 spoofed-fingerprint attempts
    for (let i = 0; i < 5; i++) {
      const d = await executeGatewayPipeline(db, {
        token,
        action: 'check_balance',
        params: {},
        intent: 'Check balance',
        provenance: 'user_instruction',
        nonce: nonce(),
        timestamp: Date.now(),
        fingerprint: { agentRuntimeId: 'attacker', ip: '185.220.101.5', asn: 'AS205100', userAgent: 'curl/8' },
      });
      expect(d.verdict).toBe('BLOCK');
    }

    const tok = db.prepare(`SELECT status FROM tokens WHERE jti = ?`).get(jti) as { status: string };
    expect(tok.status).toBe('suspended');

    const alerts = db.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE agent_id = 'agent_billpay'`).get() as { c: number };
    expect(alerts.c).toBeLessThanOrEqual(2);

    // Explicit customer re-issue endpoint returns a fresh active token and revokes the suspended jti
    const customer = request.agent(app);
    expect((await customer.post('/api/auth/login').send(CUSTOMER)).status).toBe(200);
    const reissue = await customer.post(`/api/gateway/tokens/${jti}/reissue`).send({});
    expect(reissue.status).toBe(200);
    expect(reissue.body.token).toBeTruthy();
    expect(reissue.body.replacedJti).toBe(jti);

    const oldRow = db.prepare(`SELECT status FROM tokens WHERE jti = ?`).get(jti) as { status: string };
    expect(oldRow.status).toBe('revoked');

    const newRow = db.prepare(`SELECT status FROM tokens WHERE jti = ?`).get(reissue.body.jti) as { status: string };
    expect(newRow.status).toBe('active');
  });
});

describe('Phase 1.4: bank-side defense in depth', () => {
  it('rejects /api/bank/execute if attacker holds leaked BANK_INTERNAL_SECRET alone or tampers with amount', async () => {
    const app = createApp();

    // 1. Leaked internal secret alone without gateway-signed x-bank-authorization
    const noAuth = await request(app)
      .post('/api/bank/execute')
      .set('x-bank-internal-secret', getBankInternalSecret())
      .send({
        customerId: 'cust_arjun_sen',
        agentId: 'agent_billpay',
        action: 'pay_bill',
        payeeId: 'payee_cesc',
        amount: 500,
        idempotencyKey: 'bypass_attempt_1',
      });
    expect(noAuth.status).toBe(403);

    // 2. Signed for 500 rupees (50000 paise) but tampered amount to 5000 rupees in body
    const signed = signBankExecutionAuth({
      requestId: 'req_test_1',
      customerId: 'cust_arjun_sen',
      agentId: 'agent_billpay',
      action: 'pay_bill',
      amountPaise: 50000,
      payeeId: 'payee_cesc',
      idempotencyKey: 'idem_test_1',
    });

    const tampered = await request(app)
      .post('/api/bank/execute')
      .set('x-bank-internal-secret', getBankInternalSecret())
      .set('x-bank-authorization', signed)
      .send({
        customerId: 'cust_arjun_sen',
        agentId: 'agent_billpay',
        action: 'pay_bill',
        payeeId: 'payee_cesc',
        amount: 5000,
        idempotencyKey: 'idem_test_1',
      });
    expect(tampered.status).toBe(403);

    // 3. Valid matching signature & payload succeeds
    const valid = await request(app)
      .post('/api/bank/execute')
      .set('x-bank-internal-secret', getBankInternalSecret())
      .set('x-bank-authorization', signed)
      .send({
        customerId: 'cust_arjun_sen',
        agentId: 'agent_billpay',
        action: 'pay_bill',
        payeeId: 'payee_cesc',
        amount: 500,
        idempotencyKey: 'idem_test_1',
      });
    expect(valid.status).toBe(200);
    expect(valid.body.status).toBe('executed');
  });

  it('enforces BankService independent per-txn ceiling (BANK_MAX_TXN_RUPEES)', () => {
    process.env.BANK_MAX_TXN_RUPEES = '2500';
    expect(() =>
      new BankService(db).executeAuthorizedAction({
        customerId: 'cust_arjun_sen',
        agentId: 'agent_billpay',
        action: 'pay_bill',
        payeeId: 'payee_cesc',
        amount: 3000,
        idempotencyKey: 'over_ceiling',
      })
    ).toThrow(/ceiling/i);

    const check = verifyBankExecutionAuth(undefined, {
      customerId: 'cust_arjun_sen',
      agentId: 'agent_billpay',
      action: 'pay_bill',
      amountPaise: 10000,
      payeeId: 'payee_cesc',
    });
    expect(check.valid).toBe(false);
  });
});

describe('Phase 1.5: lifecycle audit coverage & external audit anchoring', () => {
  it('chains approvals, grant revocations, and token events into the audit log and catches rewrites against external anchor', async () => {
    const app = createApp();
    const customer = request.agent(app);
    expect((await customer.post('/api/auth/login').send(CUSTOMER)).status).toBe(200);

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
      intent: 'Pay installation bill',
      provenance: 'user_instruction',
      nonce: nonce(),
      timestamp: Date.now(),
      fingerprint: DEFAULT_BILLPAY_FP,
      simulatedHour: 3,
    });
    expect(d.verdict).toBe('ASK_CUSTOMER');

    resolveApproval(db, {
      approvalId: d.approvalId!,
      decision: 'approve',
      pin: '2026',
      customerId: 'cust_arjun_sen',
    });

    await customer.post('/api/customer/grants/grant_billpay_main/revoke').send({});

    const lifecycleEvents = db
      .prepare(`SELECT action FROM audit_log WHERE action IN ('approval_created', 'approval_approved', 'grant_revoked')`)
      .all() as Array<{ action: string }>;
    expect(lifecycleEvents.map((e) => e.action)).toEqual(
      expect.arrayContaining(['approval_created', 'approval_approved', 'grant_revoked'])
    );
    expect(verifyAuditChain(db).valid).toBe(true);

    // Export an external anchor
    const anchor = exportAuditAnchor(db);
    expect(verifyAuditAgainstAnchor(db, anchor).valid).toBe(true);

    // Simulate an attacker with DB write access truncating the tail AND forging audit_head (simulating leaked HMAC key too):
    // Even if verifyAuditChain() passes after forged head update, external anchor MUST fail!
    db.prepare(`DELETE FROM audit_log WHERE seq = (SELECT MAX(seq) FROM audit_log)`).run();
    const check = verifyAuditAgainstAnchor(db, anchor);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/mismatch|truncated|exceeds/i);
  });
});
