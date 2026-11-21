import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { getDb } from './database.ts';
import { computeEntryHash, signAuditHmac, sha256Hex, hashSecret } from '../gateway/crypto.ts';
import { refreshAuditHead } from '../gateway/stage5_audit.ts';
import { isDemoMode, isProd } from '../config.ts';
import { rupeesToPaise } from '../money.ts';

function hashPassword(password: string): string {
  return hashSecret(password);
}

export function resetAndSeedDatabase(dbArg?: Database.Database): void {
  const db = dbArg ?? getDb();

  const tables = [
    'approvals',
    'decisions',
    'requests',
    'audit_log',
    'audit_head',
    'alerts',
    'used_nonces',
    'tokens',
    'grants',
    'baselines',
    'sessions',
    'transactions',
    'payees',
    'accounts',
    'agents',
    'users',
    'customers',
    'settings',
  ];

  db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'audit_log'`).run();

    const now = Date.now();
    const dayMs = 86_400_000;

    // 1. Customer: Arjun Sen, Kolkata (Asia/Kolkata IST timezone)
    const customerId = 'cust_arjun_sen';
    db.prepare(
      `INSERT INTO customers (id, name, email, city, timezone, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(customerId, 'Arjun Sen', 'arjun.sen@example.in', 'Kolkata', 'Asia/Kolkata', hashPassword('2026'), now - 35 * dayMs);

    // 2. Users (customer + bank_admin)
    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, role, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('user_arjun', 'arjun.sen@example.in', hashPassword('arjun2026'), 'Arjun Sen', 'customer', customerId, now - 35 * dayMs);

    db.prepare(
      `INSERT INTO users (id, email, password_hash, name, role, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('user_admin', 'admin@agentshield.bank', hashPassword('admin2026'), 'Priya Nair', 'bank_admin', null, now - 35 * dayMs);

    // 3. Bank Account (stored in integer paise: ₹1,42,500.00 = 14,250,000 paise)
    const accountId = 'acc_indb_7841';
    db.prepare(
      `INSERT INTO accounts (id, customer_id, account_number, account_type, currency, balance, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(accountId, customerId, 'INDB-7841-9920', 'Savings', 'INR', rupeesToPaise(142500), now);

    // 4. Verified Indian Payees
    const payees = [
      { id: 'payee_cesc', name: 'CESC Kolkata', vpa: 'cesc.kolkata@icici', category: 'electricity', verified: 1 },
      { id: 'payee_jio', name: 'Jio Fiber', vpa: 'jiofiber.bill@hdfcbank', category: 'telecom', verified: 1 },
      { id: 'payee_kmc', name: 'KMC Water Tax', vpa: 'kmc.water@sbi', category: 'water', verified: 1 },
      { id: 'payee_bgas', name: 'Bengal Gas Co', vpa: 'bengalgas@axisbank', category: 'gas', verified: 1 },
      { id: 'payee_airtel', name: 'Airtel Postpaid', vpa: 'airtel.postpaid@okicici', category: 'telecom', verified: 1 },
    ];
    const insertPayee = db.prepare(
      `INSERT INTO payees (id, customer_id, name, vpa, category, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of payees) {
      insertPayee.run(p.id, customerId, p.name, p.vpa, p.category, p.verified, now - 35 * dayMs);
    }

    // 5. Three Registered AI Agents
    const agents = [
      {
        id: 'agent_billpay',
        name: 'BillPay Autopilot',
        publisher: 'FinTech Labs India',
        description: 'Automated monthly utility bill settlement agent for electricity, fiber, water, and piped gas.',
        publicKey: 'ed25519:pk_billpay_8f9a2c',
        secretHash: sha256Hex('secret_billpay_2026'),
        status: 'active',
        riskTier: 'low',
      },
      {
        id: 'agent_spendtracker',
        name: 'SpendTracker Insights',
        publisher: 'WealthPulse Analytics',
        description: 'Read-only personal cashflow and utility spending analyzer.',
        publicKey: 'ed25519:pk_spendtracker_3d1b7e',
        secretHash: sha256Hex('secret_spendtracker_2026'),
        status: 'active',
        riskTier: 'low',
      },
      {
        id: 'agent_shopbuddy',
        name: 'ShopBuddy AI',
        publisher: 'Unverified Marketplace SDK',
        description: 'Third-party shopping & checkout assistant with elevated anomaly telemetry.',
        publicKey: 'ed25519:pk_shopbuddy_9c4e11',
        secretHash: sha256Hex('secret_shopbuddy_2026'),
        status: 'active',
        riskTier: 'elevated',
      },
    ];
    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, publisher, description, public_key, secret_hash, status, risk_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const a of agents) {
      insertAgent.run(a.id, a.name, a.publisher, a.description, a.publicKey, a.secretHash, a.status, a.riskTier, now - 35 * dayMs);
    }

    // 6. Active Grants (caps stored in integer paise)
    const dec31 = now + 365 * dayMs;
    const insertGrant = db.prepare(
      `INSERT INTO grants (id, customer_id, agent_id, title, allowed_actions, allowed_categories, payee_allowlist, per_txn_limit, daily_limit, monthly_limit, valid_from, valid_until, allowed_hours, status, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insertGrant.run(
      'grant_billpay_main',
      customerId,
      'agent_billpay',
      'Pay utility bills up to ₹5,000 until Dec 31',
      JSON.stringify(['pay_bill', 'check_balance']),
      JSON.stringify(['electricity', 'telecom', 'water', 'gas']),
      JSON.stringify([]),
      rupeesToPaise(5000),
      rupeesToPaise(10000),
      rupeesToPaise(25000),
      now - 30 * dayMs,
      dec31,
      JSON.stringify([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]),
      'active',
      null,
      now - 30 * dayMs
    );

    insertGrant.run(
      'grant_spendtracker_ro',
      customerId,
      'agent_spendtracker',
      'Read-only balance & spend analytics',
      JSON.stringify(['check_balance']),
      JSON.stringify(['electricity', 'telecom', 'water', 'gas']),
      JSON.stringify([]),
      0,
      0,
      0,
      now - 30 * dayMs,
      dec31,
      null,
      'active',
      null,
      now - 30 * dayMs
    );

    insertGrant.run(
      'grant_shopbuddy_ltd',
      customerId,
      'agent_shopbuddy',
      'Restricted bill payment up to ₹5,000',
      JSON.stringify(['pay_bill', 'check_balance']),
      JSON.stringify(['electricity', 'telecom']),
      JSON.stringify(['payee_cesc', 'payee_jio']),
      rupeesToPaise(5000),
      rupeesToPaise(8000),
      rupeesToPaise(15000),
      now - 15 * dayMs,
      dec31,
      JSON.stringify([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
      'active',
      null,
      now - 15 * dayMs
    );

    // 7. 30 Days of Historical Transactions (amounts in integer paise)
    const historicalTxns = [
      { daysAgo: 29, hour: 10, agent: 'agent_billpay', payee: 'payee_cesc', name: 'CESC Kolkata', cat: 'electricity', amtPaise: rupeesToPaise(1820) },
      { daysAgo: 28, hour: 11, agent: 'agent_billpay', payee: 'payee_jio', name: 'Jio Fiber', cat: 'telecom', amtPaise: rupeesToPaise(999) },
      { daysAgo: 26, hour: 14, agent: 'agent_billpay', payee: 'payee_bgas', name: 'Bengal Gas Co', cat: 'gas', amtPaise: rupeesToPaise(680) },
      { daysAgo: 25, hour: 9, agent: 'agent_billpay', payee: 'payee_kmc', name: 'KMC Water Tax', cat: 'water', amtPaise: rupeesToPaise(450) },
      { daysAgo: 23, hour: 16, agent: 'agent_billpay', payee: 'payee_airtel', name: 'Airtel Postpaid', cat: 'telecom', amtPaise: rupeesToPaise(599) },
      { daysAgo: 21, hour: 11, agent: 'agent_billpay', payee: 'payee_cesc', name: 'CESC Kolkata', cat: 'electricity', amtPaise: rupeesToPaise(1890) },
      { daysAgo: 19, hour: 18, agent: 'agent_billpay', payee: 'payee_jio', name: 'Jio Fiber', cat: 'telecom', amtPaise: rupeesToPaise(999) },
      { daysAgo: 17, hour: 10, agent: 'agent_billpay', payee: 'payee_bgas', name: 'Bengal Gas Co', cat: 'gas', amtPaise: rupeesToPaise(710) },
      { daysAgo: 15, hour: 15, agent: 'agent_billpay', payee: 'payee_cesc', name: 'CESC Kolkata', cat: 'electricity', amtPaise: rupeesToPaise(1780) },
      { daysAgo: 13, hour: 12, agent: 'agent_billpay', payee: 'payee_kmc', name: 'KMC Water Tax', cat: 'water', amtPaise: rupeesToPaise(480) },
      { daysAgo: 11, hour: 17, agent: 'agent_billpay', payee: 'payee_airtel', name: 'Airtel Postpaid', cat: 'telecom', amtPaise: rupeesToPaise(599) },
      { daysAgo: 9, hour: 10, agent: 'agent_billpay', payee: 'payee_cesc', name: 'CESC Kolkata', cat: 'electricity', amtPaise: rupeesToPaise(1850) },
      { daysAgo: 7, hour: 13, agent: 'agent_billpay', payee: 'payee_jio', name: 'Jio Fiber', cat: 'telecom', amtPaise: rupeesToPaise(999) },
      { daysAgo: 5, hour: 11, agent: 'agent_billpay', payee: 'payee_bgas', name: 'Bengal Gas Co', cat: 'gas', amtPaise: rupeesToPaise(690) },
      { daysAgo: 3, hour: 14, agent: 'agent_billpay', payee: 'payee_cesc', name: 'CESC Kolkata', cat: 'electricity', amtPaise: rupeesToPaise(1840) },
    ];

    const insertTxn = db.prepare(
      `INSERT INTO transactions (id, account_id, customer_id, agent_id, payee_id, payee_name, category, action, amount, status, idempotency_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    historicalTxns.forEach((t, idx) => {
      const ts = now - t.daysAgo * dayMs;
      const d = new Date(ts);
      // IST is UTC+5:30; anchor historical timestamps in IST wall hours
      d.setUTCHours(t.hour - 5, 15, 0, 0);
      insertTxn.run(
        `txn_hist_${idx + 1}`,
        accountId,
        customerId,
        t.agent,
        t.payee,
        t.name,
        t.cat,
        'pay_bill',
        t.amtPaise,
        'completed',
        `idem_hist_${idx + 1}`,
        `Monthly ${t.cat} bill settlement`,
        d.getTime()
      );
    });

    // Compute real baseline stats from historical transactions in integer paise
    const amountsPaise = historicalTxns.map((t) => t.amtPaise);
    const meanPaise = amountsPaise.reduce((a, b) => a + b, 0) / amountsPaise.length;
    const variancePaise = amountsPaise.reduce((s, v) => s + (v - meanPaise) ** 2, 0) / amountsPaise.length;
    const stdPaise = Math.max(rupeesToPaise(150), Math.round(Math.sqrt(variancePaise)));

    const insertBaseline = db.prepare(
      `INSERT INTO baselines (id, agent_id, customer_id, sample_count, typical_amount_mean, typical_amount_std, typical_hours, known_payees, typical_action_mix, typical_call_rate_per_min, last_action_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insertBaseline.run(
      'base_billpay',
      'agent_billpay',
      customerId,
      historicalTxns.length,
      Math.round(meanPaise),
      stdPaise,
      JSON.stringify([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
      JSON.stringify(['payee_cesc', 'payee_jio', 'payee_kmc', 'payee_bgas', 'payee_airtel']),
      JSON.stringify({ pay_bill: 0.75, check_balance: 0.25 }),
      2.0,
      'pay_bill',
      now
    );

    insertBaseline.run(
      'base_spendtracker',
      'agent_spendtracker',
      customerId,
      20,
      0,
      0,
      JSON.stringify([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
      JSON.stringify([]),
      JSON.stringify({ check_balance: 1.0 }),
      1.5,
      'check_balance',
      now
    );

    insertBaseline.run(
      'base_shopbuddy',
      'agent_shopbuddy',
      customerId,
      8,
      rupeesToPaise(1200),
      rupeesToPaise(350),
      JSON.stringify([10, 11, 12, 14, 15, 16, 18, 19]),
      JSON.stringify(['payee_cesc', 'payee_jio']),
      JSON.stringify({ pay_bill: 0.5, check_balance: 0.5 }),
      1.5,
      'check_balance',
      now
    );

    // 8. Seed initial verified audit entries from recent history
    const genesisHash = '0'.repeat(64);
    let prevHash = genesisHash;

    const seedRequests = [
      {
        reqId: 'req_seed_1',
        agentId: 'agent_billpay',
        grantId: 'grant_billpay_main',
        action: 'pay_bill',
        category: 'electricity',
        payeeId: 'payee_cesc',
        payeeName: 'CESC Kolkata',
        amountPaise: rupeesToPaise(1840),
        intent: 'Pay monthly CESC Kolkata electricity bill',
        provenance: 'user_instruction',
        verdict: 'ALLOW',
        riskScore: 8,
        reasons: ['Known electricity provider CESC Kolkata within ₹5,000 limit'],
        techReasons: ['Stage 1-3 passed: verified token, active grant, z-score 0.88'],
        daysAgo: 3,
      },
      {
        reqId: 'req_seed_2',
        agentId: 'agent_spendtracker',
        grantId: 'grant_spendtracker_ro',
        action: 'check_balance',
        category: 'telemetry',
        payeeId: null,
        payeeName: 'Account Summary',
        amountPaise: 0,
        intent: 'Retrieve current account balance for monthly budget report',
        provenance: 'user_instruction',
        verdict: 'ALLOW',
        riskScore: 4,
        reasons: ['Read-only balance check covered by SpendTracker grant'],
        techReasons: ['Read-only action within grant scope and nominal call rate'],
        daysAgo: 2,
      },
      {
        reqId: 'req_seed_3',
        agentId: 'agent_billpay',
        grantId: 'grant_billpay_main',
        action: 'pay_bill',
        category: 'telecom',
        payeeId: 'payee_jio',
        payeeName: 'Jio Fiber',
        amountPaise: rupeesToPaise(999),
        intent: 'Settle Jio Fiber broadband invoice',
        provenance: 'user_instruction',
        verdict: 'ALLOW',
        riskScore: 6,
        reasons: ['Recurring telecom payment matches 30-day baseline'],
        techReasons: ['Verified payee_jio, amount ₹999 consistent with ₹999 history'],
        daysAgo: 1,
      },
    ];

    const insertReq = db.prepare(
      `INSERT INTO requests (id, agent_id, customer_id, grant_id, session_id, action, category, payee_id, payee_name, amount, stated_intent, provenance, context_snippet, idempotency_key, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertDec = db.prepare(
      `INSERT INTO decisions (id, request_id, verdict, risk_score, reasons, technical_reasons, signals, stage_results, latency_ms, hard_block, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAudit = db.prepare(
      `INSERT INTO audit_log (id, timestamp, request_id, agent_id, customer_id, action, payload_hash, decision, risk_score, reasons, stage_results, prev_hash, entry_hash, hmac_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    seedRequests.forEach((s, idx) => {
      const ts = now - s.daysAgo * dayMs;
      const payloadHash = sha256Hex(JSON.stringify({ action: s.action, payeeId: s.payeeId, amountPaise: s.amountPaise, intent: s.intent }));
      const stageResults = [
        { stage: 1, name: 'Identity & Token Binding', status: 'PASS', latencyMs: 3.1, summary: 'Verified JWT & device fingerprint', details: {} },
        { stage: 2, name: 'Scoped Delegation', status: 'PASS', latencyMs: 2.4, summary: 'Action & limit authorized by grant', details: {} },
        { stage: 3, name: 'Behaviour & Intent Engine', status: 'PASS', latencyMs: 5.8, summary: `Risk score ${s.riskScore}/100 within ALLOW band`, details: {} },
        { stage: 4, name: 'Human Escalation', status: 'SKIPPED', latencyMs: 0.2, summary: 'Below escalation threshold', details: {} },
        { stage: 5, name: 'Tamper-Evident Audit', status: 'PASS', latencyMs: 1.9, summary: 'SHA-256 hash chain appended', details: {} },
      ];

      insertReq.run(
        s.reqId,
        s.agentId,
        customerId,
        s.grantId,
        `sess_seed_${idx + 1}`,
        s.action,
        s.category,
        s.payeeId,
        s.payeeName,
        s.amountPaise,
        s.intent,
        s.provenance,
        null,
        `idem_seed_${idx + 1}`,
        payloadHash,
        ts
      );

      insertDec.run(
        `dec_seed_${idx + 1}`,
        s.reqId,
        s.verdict,
        s.riskScore,
        JSON.stringify(s.reasons),
        JSON.stringify(s.techReasons),
        JSON.stringify([]),
        JSON.stringify(stageResults),
        13.4,
        0,
        ts
      );

      const auditId = `aud_seed_${idx + 1}`;
      const canonicalPayload = {
        id: auditId,
        timestamp: ts,
        requestId: s.reqId,
        agentId: s.agentId,
        customerId,
        action: s.action,
        payloadHash,
        decision: s.verdict,
        riskScore: s.riskScore,
        reasons: s.reasons,
        stageResults,
      };
      const entryHash = computeEntryHash(prevHash, canonicalPayload);
      const hmacSig = signAuditHmac(entryHash);

      insertAudit.run(
        auditId,
        ts,
        s.reqId,
        s.agentId,
        customerId,
        s.action,
        payloadHash,
        s.verdict,
        s.riskScore,
        JSON.stringify(s.reasons),
        JSON.stringify(stageResults),
        prevHash,
        entryHash,
        hmacSig
      );
      prevHash = entryHash;
    });
    refreshAuditHead(db, now);

    // 9. Settings
    const defaultSettings = [
      ['allow_max_score', '39'],
      ['ask_max_score', '69'],
      ['approval_expiry_minutes', '10'],
      ['rate_limit_per_minute', '60'],
      ['enable_llm_judge', 'true'],
      ['ask_customer_on_block', 'false'],
      ['always_ask_customer', 'false'],
      ['money_unit', 'paise'],
    ];
    const insertSetting = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`);
    for (const [k, v] of defaultSettings) {
      insertSetting.run(k, v, now);
    }
  })();
}

export function ensureSeeded(dbArg?: Database.Database): void {
  const db = dbArg ?? getDb();
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM customers`).get() as { cnt: number };
  if (row.cnt !== 0) return;
  if (!isProd() || isDemoMode()) {
    resetAndSeedDatabase(db);
    return;
  }
  bootstrapProductionAdmin(db);
}

/** Production first-run: create one admin from env vars. No customers, no default passwords. */
export function bootstrapProductionAdmin(db: Database.Database): void {
  const hasAdmin = db.prepare(`SELECT 1 FROM users WHERE role = 'bank_admin' LIMIT 1`).get();
  if (hasAdmin) return;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    console.warn(
      '[agentshield] Empty production database and no admin created. Set BOOTSTRAP_ADMIN_EMAIL and ' +
        'BOOTSTRAP_ADMIN_PASSWORD (min 12 chars) for first start, then remove them.'
    );
    return;
  }
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, customer_id, created_at) VALUES (?, ?, ?, ?, 'bank_admin', NULL, ?)`
  ).run(`user_admin_${crypto.randomBytes(4).toString('hex')}`, email.toLowerCase(), hashPassword(password), 'Bank Admin', Date.now());
  console.warn(`[agentshield] Bootstrap admin ${email} created. Remove BOOTSTRAP_ADMIN_* from the environment.`);
}
