import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { Response } from 'express';
import { initSchema, setDbForTest } from '../server/db/database.ts';
import { resetAndSeedDatabase } from '../server/db/seed.ts';
import { createApp } from '../server/app.ts';
import { hashSecret } from '../server/gateway/crypto.ts';
import { executeGatewayPipeline } from '../server/gateway/pipeline.ts';
import { DEFAULT_BILLPAY_FP, issueTokenInDb } from '../server/gateway/selftest.ts';
import { addSseClient, broadcastSseEvent, removeSseClient } from '../server/sse.ts';
import { assertConfig } from '../server/config.ts';
import { resetLoginThrottle } from '../server/routes/appRoutes.ts';

const CUSTOMER = { email: 'arjun.sen@example.in', password: 'arjun2026' };
const ADMIN = { email: 'admin@agentshield.bank', password: 'admin2026' };

let db: Database.Database;
const saved = { ...process.env };

function useMode(demo: boolean) {
  process.env.DEMO_MODE = demo ? 'true' : 'false';
  delete process.env.TRUST_CLIENT_FINGERPRINT;
}

async function login(app: ReturnType<typeof createApp>, creds: { email: string; password: string }) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/login').send(creds);
  expect(r.status).toBe(200);
  return agent;
}

async function makeApproval(): Promise<string> {
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
  return d.approvalId!;
}

function addOtherCustomer() {
  const now = Date.now();
  db.prepare(`INSERT INTO customers (id, name, email, city, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'cust_other', 'Other Person', 'other@example.in', 'Pune', hashSecret('9999'), now
  );
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('user_other', 'other@example.in', hashSecret('other-pass'), 'Other Person', 'customer', 'cust_other', now);
}

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  resetAndSeedDatabase(db);
  setDbForTest(db);
  resetLoginThrottle();
});
afterEach(() => {
  process.env = { ...saved };
});

describe('access control (production-style, DEMO_MODE=false)', () => {
  beforeEach(() => useMode(false));

  it('has no implicit session and hides demo-only routes', async () => {
    const app = createApp();
    const me = await request(app).get('/api/auth/me');
    expect(me.body.user).toBeNull();
    expect(me.body.demoMode).toBe(false);

    expect((await request(app).get('/api/customer/overview')).status).toBe(401);
    expect((await request(app).get('/api/console/overview')).status).toBe(401);
    expect((await request(app).post('/api/gateway/tokens').send({})).status).toBe(401);
    expect((await request(app).post('/api/auth/switch-role').send({ role: 'bank_admin' })).status).toBe(404);
    expect((await request(app).post('/api/reset-demo')).status).toBe(404);
    expect((await request(app).post('/api/audit/simulate-tamper').send({ confirmDemo: true })).status).toBe(404);
    expect((await request(app).post('/api/gateway/scenario').send({ scenarioId: 'legit_bill' })).status).toBe(404);
  });

  it('keeps the bank console admin-only', async () => {
    const app = createApp();
    const customer = await login(app, CUSTOMER);
    expect((await customer.get('/api/console/overview')).status).toBe(403);
    expect((await customer.post('/api/console/settings').send({ allow_max_score: 30, ask_max_score: 60 })).status).toBe(403);

    const admin = await login(app, ADMIN);
    const ok = await admin.get('/api/console/overview');
    expect(ok.status).toBe(200);
    expect(ok.body.kpis).toBeTruthy();
  });

  it('rejects wrong passwords and throttles repeated attempts', async () => {
    const app = createApp();
    const bad = await request(app).post('/api/auth/login').send({ email: CUSTOMER.email, password: 'nope' });
    expect(bad.status).toBe(401);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await request(app).post('/api/auth/login').send({ email: CUSTOMER.email, password: 'nope' })).status;
    }
    expect(last).toBe(429);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const app = createApp();
    const customer = await login(app, CUSTOMER);
    const r = await customer
      .post('/api/customer/grants/grant_billpay_main/revoke')
      .set('Origin', 'https://evil.example');
    expect(r.status).toBe(403);
  });

  it('derives the agent address from the connection, so a spoofed fingerprint IP cannot reuse a token', async () => {
    const app = createApp();
    const { token } = await issueTokenInDb(db, {
      agentId: 'agent_billpay',
      customerId: 'cust_arjun_sen',
      grantId: 'grant_billpay_main',
      fingerprint: DEFAULT_BILLPAY_FP, // bound to 103.21.58.14
    });
    const r = await request(app)
      .post('/api/gateway/execute')
      .send({
        token,
        action: 'check_balance',
        params: {},
        intent: 'Check balance',
        nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`,
        timestamp: Date.now(),
        fingerprint: DEFAULT_BILLPAY_FP, // claims the right IP, but the socket says 127.0.0.1
      });
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe('BLOCK');
    expect(r.body.technicalReasons).toBeUndefined();
    expect(JSON.stringify(r.body.reasons)).toMatch(/unrecognized device/i);
  });
});

describe('approvals', () => {
  beforeEach(() => useMode(false));

  it('always requires the PIN and locks after repeated wrong guesses', async () => {
    const app = createApp();
    const approvalId = await makeApproval();
    const customer = await login(app, CUSTOMER);

    const noPin = await customer.post(`/api/customer/approvals/${approvalId}/resolve`).send({ decision: 'approve' });
    expect(noPin.status).toBe(403);
    // The old client-controlled bypass flag is ignored
    const bypass = await customer
      .post(`/api/customer/approvals/${approvalId}/resolve`)
      .send({ decision: 'approve', requirePin: false });
    expect(bypass.status).toBe(403);

    let status = 0;
    for (let i = 0; i < 6; i++) {
      status = (await customer.post(`/api/customer/approvals/${approvalId}/resolve`).send({ decision: 'approve', pin: '0000' })).status;
    }
    expect(status).toBe(423);
    // even the right PIN is refused once locked
    expect((await customer.post(`/api/customer/approvals/${approvalId}/resolve`).send({ decision: 'approve', pin: '2026' })).status).toBe(423);
    // deny still works
    const deny = await customer.post(`/api/customer/approvals/${approvalId}/resolve`).send({ decision: 'deny' });
    expect(deny.status).toBe(200);
    expect(deny.body.status).toBe('denied');
  });

  it('settles with the right PIN exactly once', async () => {
    const app = createApp();
    const approvalId = await makeApproval();
    const customer = await login(app, CUSTOMER);
    const ok = await customer.post(`/api/customer/approvals/${approvalId}/resolve`).send({ decision: 'approve', pin: '2026' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    const again = await customer.post(`/api/customer/approvals/${approvalId}/resolve`).send({ decision: 'approve', pin: '2026' });
    expect(again.body.bankResult).toBeUndefined();
  });

  it("does not let another customer see or resolve someone else's approval", async () => {
    const app = createApp();
    addOtherCustomer();
    const approvalId = await makeApproval();
    const other = await login(app, { email: 'other@example.in', password: 'other-pass' });
    const r = await other.post(`/api/customer/approvals/${approvalId}/resolve`).send({ decision: 'approve', pin: '9999' });
    expect(r.status).toBe(404);
    const overview = await other.get('/api/customer/overview');
    expect(overview.body.pendingApprovals).toHaveLength(0);
  });

  it('remembers the payee when the customer chooses "always trust this payee"', async () => {
    const app = createApp();
    const approvalId = await makeApproval();
    const customer = await login(app, CUSTOMER);
    await customer.post(`/api/customer/approvals/${approvalId}/resolve`).send({ decision: 'approve', pin: '2026', trustPayee: true });
    const row = db.prepare(`SELECT known_payees FROM baselines WHERE agent_id = 'agent_billpay'`).get() as { known_payees: string };
    expect(JSON.parse(row.known_payees)).toContain('payee_new_solar');
  });

  it('reports an explicit EXPIRED state to the agent', async () => {
    const app = createApp();
    const approvalId = await makeApproval();
    const reqId = (db.prepare(`SELECT request_id FROM approvals WHERE id = ?`).get(approvalId) as { request_id: string }).request_id;
    db.prepare(`UPDATE approvals SET expires_at = ? WHERE id = ?`).run(Date.now() - 1000, approvalId);
    const customer = await login(app, CUSTOMER);
    const r = await customer.get(`/api/gateway/requests/${reqId}`);
    expect(r.status).toBe(200);
    expect(r.body.finalStatus).toBe('EXPIRED');
  });

  it('only shows request status to the owning agent, customer or an admin', async () => {
    const app = createApp();
    addOtherCustomer();
    const approvalId = await makeApproval();
    const reqId = (db.prepare(`SELECT request_id FROM approvals WHERE id = ?`).get(approvalId) as { request_id: string }).request_id;
    expect((await request(app).get(`/api/gateway/requests/${reqId}`)).status).toBe(404);
    const other = await login(app, { email: 'other@example.in', password: 'other-pass' });
    expect((await other.get(`/api/gateway/requests/${reqId}`)).status).toBe(404);
  });
});

describe('token issuance', () => {
  beforeEach(() => useMode(false));

  it('issues tokens only to the grant owner, for an active grant', async () => {
    const app = createApp();
    addOtherCustomer();
    const owner = await login(app, CUSTOMER);
    const ok = await owner.post('/api/gateway/tokens').send({ agentId: 'agent_billpay', grantId: 'grant_billpay_main' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();

    const other = await login(app, { email: 'other@example.in', password: 'other-pass' });
    expect((await other.post('/api/gateway/tokens').send({ agentId: 'agent_billpay', grantId: 'grant_billpay_main' })).status).toBe(404);

    expect((await owner.post('/api/gateway/tokens').send({ agentId: 'agent_shopbuddy', grantId: 'grant_billpay_main' })).status).toBe(404);

    await owner.post('/api/customer/grants/grant_billpay_main/revoke');
    expect((await owner.post('/api/gateway/tokens').send({ agentId: 'agent_billpay', grantId: 'grant_billpay_main' })).status).toBe(409);
  });

  it("cannot revoke another customer's grant", async () => {
    const app = createApp();
    addOtherCustomer();
    const other = await login(app, { email: 'other@example.in', password: 'other-pass' });
    expect((await other.post('/api/customer/grants/grant_billpay_main/revoke')).status).toBe(404);
  });
});

describe('demo mode', () => {
  it('gives signed-out visitors a customer preview but never admin or console access', async () => {
    useMode(true);
    const app = createApp();
    const me = await request(app).get('/api/auth/me');
    expect(me.body.user.role).toBe('customer');
    expect((await request(app).get('/api/customer/overview')).status).toBe(200);
    expect((await request(app).get('/api/console/overview')).status).toBe(403);
    expect((await request(app).post('/api/reset-demo')).status).toBe(200);
  });
});

describe('live events', () => {
  it("send a customer's decisions only to that customer and to admins", () => {
    const got: Record<string, string[]> = { a: [], b: [], admin: [] };
    const fake = (k: string) => ({ write: (s: string) => got[k].push(s) } as unknown as Response);
    addSseClient('a', fake('a'), 'customer', 'cust_a');
    addSseClient('b', fake('b'), 'customer', 'cust_b');
    addSseClient('admin', fake('admin'), 'bank_admin', null);
    broadcastSseEvent('gateway:decision', { customerId: 'cust_a', verdict: 'BLOCK' });
    broadcastSseEvent('demo:reset', { timestamp: 1 });
    ['a', 'b', 'admin'].forEach(removeSseClient);
    expect(got.a).toHaveLength(2);
    expect(got.admin).toHaveLength(2);
    expect(got.b).toHaveLength(1); // only the account-free reset notice
  });
});

describe('production configuration', () => {
  it('refuses to start without real, distinct secrets', () => {
    process.env.NODE_ENV = 'production';
    for (const k of ['AGENTSHIELD_JWT_SECRET', 'AGENTSHIELD_AUDIT_HMAC_KEY', 'BANK_INTERNAL_SECRET', 'SESSION_SECRET']) delete process.env[k];
    expect(() => assertConfig()).toThrow(/must be set/);

    const same = 'x'.repeat(32);
    for (const k of ['AGENTSHIELD_JWT_SECRET', 'AGENTSHIELD_AUDIT_HMAC_KEY', 'BANK_INTERNAL_SECRET', 'SESSION_SECRET']) process.env[k] = same;
    expect(() => assertConfig()).toThrow(/unique/);

    process.env.AGENTSHIELD_JWT_SECRET = 'a'.repeat(32);
    process.env.AGENTSHIELD_AUDIT_HMAC_KEY = 'b'.repeat(32);
    process.env.BANK_INTERNAL_SECRET = 'c'.repeat(32);
    process.env.SESSION_SECRET = 'd'.repeat(32);
    expect(() => assertConfig()).not.toThrow();
  });
});
