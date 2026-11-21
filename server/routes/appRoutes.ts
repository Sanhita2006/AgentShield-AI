import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { BankService } from '../bank/bankService.ts';
import { getDb } from '../db/database.ts';
import { resetAndSeedDatabase } from '../db/seed.ts';
import { runFullSelfTest } from '../gateway/selftest.ts';
import { ApprovalError, createHazardousOverrideFromRequest, expirePendingApprovals, resolveApproval } from '../gateway/stage4_escalation.ts';
import { getSettings } from '../gateway/stage3_behavior.ts';
import { verifySecret } from '../gateway/crypto.ts';
import {
  appendLifecycleAudit,
  exportAuditAnchor,
  simulateAuditTampering,
  verifyAuditAgainstAnchor,
  verifyAuditChain,
} from '../gateway/stage5_audit.ts';
import { addSseClient, removeSseClient, broadcastSseEvent } from '../sse.ts';
import { isDemoMode } from '../config.ts';
import { paiseToRupees, tryRupeesToPaise } from '../money.ts';
import { generateAndSaveBenchmarkReport, loadSavedBenchmarkSummary } from '../gateway/benchmark.ts';
import {
  SESSION_COOKIE,
  getCurrentUser,
  requireAdmin,
  requireCustomer,
  requireDemoMode,
  requireUser,
  setSessionCookie,
} from '../auth.ts';
import type { UserRole } from '../types.ts';

const router = Router();

// Per-IP throttle on FAILED sign-ins: 10 failures / 5 minutes
const loginFailures = new Map<string, number[]>();
function recentFailures(key: string): number[] {
  const recent = (loginFailures.get(key) || []).filter((t) => t > Date.now() - 300_000);
  loginFailures.set(key, recent);
  return recent;
}
setInterval(() => {
  for (const k of loginFailures.keys()) recentFailures(k);
  for (const [k, v] of loginFailures) if (v.length === 0) loginFailures.delete(k);
}, 60_000).unref();
export function resetLoginThrottle(): void {
  loginFailures.clear();
}

type UserRow = { id: string; email: string; name: string; role: UserRole; customer_id: string | null; password_hash?: string };

// --- AUTH ROUTES ---
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/auth/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid email and password required' });
    return;
  }
  const ipKey = req.ip || 'unknown';
  const acctKey = `acct:${parsed.data.email.toLowerCase()}`;
  if (recentFailures(ipKey).length >= 10 || recentFailures(acctKey).length >= 20) {
    res.status(429).json({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
    return;
  }
  const user = getDb()
    .prepare(`SELECT id, email, name, role, customer_id, password_hash FROM users WHERE LOWER(email) = LOWER(?)`)
    .get(parsed.data.email) as UserRow | undefined;

  const ok = verifySecret(parsed.data.password, user?.password_hash ?? 'scrypt$00$00');
  if (!user || !ok) {
    recentFailures(ipKey).push(Date.now());
    recentFailures(acctKey).push(Date.now());
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const session = setSessionCookie(res, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    customerId: user.customer_id,
  });
  res.json({ user: session });
});

router.post('/auth/switch-role', requireDemoMode, (req, res) => {
  const role = req.body?.role === 'bank_admin' ? 'bank_admin' : 'customer';
  const user = getDb()
    .prepare(`SELECT id, email, name, role, customer_id FROM users WHERE role = ? LIMIT 1`)
    .get(role) as UserRow | undefined;
  if (!user) {
    res.status(404).json({ error: 'Demo user not found' });
    return;
  }
  const session = setSessionCookie(res, {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    customerId: user.customer_id,
  });
  res.json({ user: session });
});

router.get('/auth/me', (req, res) => {
  res.json({ user: getCurrentUser(req), demoMode: isDemoMode() });
});

router.post('/auth/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// --- SSE STREAM ---
router.get('/events/stream', requireUser, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const clientId = crypto.randomBytes(6).toString('hex');
  addSseClient(clientId, res, req.user!.role, req.user!.customerId);
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: Date.now() })}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeSseClient(clientId);
  });
});

// --- CUSTOMER APP ROUTES ---
router.get('/customer/overview', requireCustomer, (req, res) => {
  const customerId = req.user!.customerId!;
  const db = getDb();
  for (const a of expirePendingApprovals(db)) {
    broadcastSseEvent('approval:resolved', { approvalId: a.id, customerId: a.customer_id, status: 'expired' });
  }
  const bank = new BankService(db);
  const bankSummary = bank.getAccountSummary(customerId);

  const agents = db.prepare(`SELECT id, name, publisher, description, status, risk_tier FROM agents ORDER BY created_at ASC`).all();

  const grants = db
    .prepare(
      `SELECT g.*, a.name AS agent_name, a.publisher AS agent_publisher
       FROM grants g JOIN agents a ON g.agent_id = a.id
       WHERE g.customer_id = ?
       ORDER BY g.created_at DESC`
    )
    .all(customerId) as Array<Record<string, unknown>>;

  const now = Date.now();
  const dayStart = now - 86_400_000;
  const monthStart = now - 30 * 86_400_000;

  const enrichedGrants = grants.map((g) => {
    const dailySpentPaise = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE customer_id = ? AND agent_id = ? AND status = 'completed' AND created_at >= ?`
        )
        .get(customerId, g.agent_id, dayStart) as { total: number }
    ).total;
    const monthlySpentPaise = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE customer_id = ? AND agent_id = ? AND status = 'completed' AND created_at >= ?`
        )
        .get(customerId, g.agent_id, monthStart) as { total: number }
    ).total;

    const perTxnPaise = Number(g.per_txn_limit ?? 0);
    const dailyLimitPaise = Number(g.daily_limit ?? 0);
    const monthlyLimitPaise = Number(g.monthly_limit ?? 0);

    return {
      ...g,
      allowed_actions: JSON.parse(String(g.allowed_actions || '[]')),
      allowed_categories: JSON.parse(String(g.allowed_categories || '[]')),
      payee_allowlist: JSON.parse(String(g.payee_allowlist || '[]')),
      per_txn_limit_paise: perTxnPaise,
      per_txn_limit: paiseToRupees(perTxnPaise),
      daily_limit_paise: dailyLimitPaise,
      daily_limit: paiseToRupees(dailyLimitPaise),
      monthly_limit_paise: monthlyLimitPaise,
      monthly_limit: paiseToRupees(monthlyLimitPaise),
      daily_spent_paise: dailySpentPaise,
      daily_spent: paiseToRupees(dailySpentPaise),
      monthly_spent_paise: monthlySpentPaise,
      monthly_spent: paiseToRupees(monthlySpentPaise),
    };
  });

  const pendingApprovals = (
    db
      .prepare(
        `SELECT ap.*, ag.name AS agent_name
       FROM approvals ap JOIN agents ag ON ap.agent_id = ag.id
       WHERE ap.customer_id = ? AND ap.status = 'pending' AND ap.expires_at > ?
       ORDER BY ap.created_at DESC`
      )
      .all(customerId, now) as Array<Record<string, unknown>>
  ).map(({ action_payload: _rawRequest, ...a }) => ({
    ...a,
    reasons: JSON.parse(String(a.reasons || '[]')),
  }));

  const activityFeed = (
    db
      .prepare(
        `SELECT r.id, r.action, r.category, r.payee_name, r.amount, r.stated_intent, r.provenance, r.created_at,
              ag.name AS agent_name, d.verdict, d.risk_score, d.reasons, d.latency_ms
       FROM requests r
       LEFT JOIN agents ag ON r.agent_id = ag.id
       LEFT JOIN decisions d ON d.request_id = r.id
       WHERE r.customer_id = ?
       ORDER BY r.created_at DESC
       LIMIT 25`
      )
      .all(customerId) as Array<Record<string, unknown>>
  ).map((row) => {
    const amtPaise = Number(row.amount ?? 0);
    return {
      ...row,
      amount_paise: amtPaise,
      amount: paiseToRupees(amtPaise),
      reasons: JSON.parse(String(row.reasons || '[]')),
    };
  });

  const alerts = db
    .prepare(`SELECT * FROM alerts WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10`)
    .all(customerId);

  const settings = getSettings(db);

  res.json({
    ...bankSummary,
    agents,
    grants: enrichedGrants,
    pendingApprovals,
    activityFeed,
    alerts,
    preferences: {
      alwaysAskCustomer: Boolean(settings.alwaysAskCustomer),
      askCustomerOnBlock: Boolean(settings.askCustomerOnBlock),
    },
  });
});

const createGrantSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().min(3).max(120),
  allowedActions: z.array(z.enum(['check_balance', 'pay_bill', 'transfer', 'add_payee'])).min(1),
  allowedCategories: z.array(z.string()).default(['electricity']),
  payeeAllowlist: z.array(z.string()).default([]),
  perTxnLimit: z.number().nonnegative().max(100000),
  dailyLimit: z.number().nonnegative().max(250000),
  monthlyLimit: z.number().nonnegative().max(1000000),
  validUntil: z.number().int(),
});

router.post('/customer/grants', requireCustomer, (req, res) => {
  const parsed = createGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid grant parameters', issues: parsed.error.issues });
    return;
  }
  if (parsed.data.validUntil <= Date.now()) {
    res.status(400).json({ error: 'A grant must expire in the future' });
    return;
  }
  const perTxnPaise = tryRupeesToPaise(parsed.data.perTxnLimit);
  const dailyPaise = tryRupeesToPaise(parsed.data.dailyLimit);
  const monthlyPaise = tryRupeesToPaise(parsed.data.monthlyLimit);
  if (perTxnPaise === null || dailyPaise === null || monthlyPaise === null) {
    res.status(400).json({ error: 'Limits must have at most 2 decimal places' });
    return;
  }
  if (perTxnPaise > dailyPaise || dailyPaise > monthlyPaise) {
    res.status(400).json({ error: 'Limits must satisfy per-transaction <= daily <= monthly' });
    return;
  }

  const customerId = req.user!.customerId!;
  const db = getDb();
  if (!db.prepare(`SELECT 1 FROM agents WHERE id = ? AND status = 'active'`).get(parsed.data.agentId)) {
    res.status(400).json({ error: 'Unknown or inactive agent' });
    return;
  }
  const id = `grant_${crypto.randomBytes(5).toString('hex')}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO grants (id, customer_id, agent_id, title, allowed_actions, allowed_categories, payee_allowlist, per_txn_limit, daily_limit, monthly_limit, valid_from, valid_until, allowed_hours, status, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', NULL, ?)`
  ).run(
    id,
    customerId,
    parsed.data.agentId,
    parsed.data.title,
    JSON.stringify(parsed.data.allowedActions),
    JSON.stringify(parsed.data.allowedCategories),
    JSON.stringify(parsed.data.payeeAllowlist),
    perTxnPaise,
    dailyPaise,
    monthlyPaise,
    now,
    parsed.data.validUntil,
    now
  );

  appendLifecycleAudit(
    db,
    {
      entityId: id,
      agentId: parsed.data.agentId,
      customerId,
      action: 'grant_created',
      decision: 'ALLOW',
      details: {
        grantId: id,
        title: parsed.data.title,
        perTxnPaise,
        dailyPaise,
        monthlyPaise,
        allowedActions: parsed.data.allowedActions,
      },
      summary: `Customer created grant "${parsed.data.title}" (${id})`,
    },
    now
  );

  broadcastSseEvent('grant:created', { customerId, grantId: id, agentId: parsed.data.agentId, title: parsed.data.title });
  res.json({ id, status: 'active' });
});

const editGrantSchema = z.object({
  title: z.string().min(3).max(120).optional(),
  perTxnLimit: z.number().nonnegative().max(100000).optional(),
  dailyLimit: z.number().nonnegative().max(250000).optional(),
  monthlyLimit: z.number().nonnegative().max(1000000).optional(),
});

router.patch('/customer/grants/:id', requireCustomer, (req, res) => {
  const parsed = editGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid grant update parameters', issues: parsed.error.issues });
    return;
  }
  const db = getDb();
  const customerId = req.user!.customerId!;
  const existing = db
    .prepare(`SELECT * FROM grants WHERE id = ? AND customer_id = ?`)
    .get(req.params.id, customerId) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Grant not found' });
    return;
  }
  if (existing.status !== 'active') {
    res.status(409).json({ error: 'Cannot edit a revoked or expired grant' });
    return;
  }

  const nextPerTxn =
    parsed.data.perTxnLimit !== undefined ? tryRupeesToPaise(parsed.data.perTxnLimit) : Number(existing.per_txn_limit);
  const nextDaily =
    parsed.data.dailyLimit !== undefined ? tryRupeesToPaise(parsed.data.dailyLimit) : Number(existing.daily_limit);
  const nextMonthly =
    parsed.data.monthlyLimit !== undefined ? tryRupeesToPaise(parsed.data.monthlyLimit) : Number(existing.monthly_limit);
  if (nextPerTxn === null || nextDaily === null || nextMonthly === null || nextPerTxn > nextDaily || nextDaily > nextMonthly) {
    res.status(400).json({ error: 'Limits must have max 2 decimals and satisfy per-txn <= daily <= monthly' });
    return;
  }
  const nextTitle = parsed.data.title ?? String(existing.title);
  const now = Date.now();
  db.prepare(`UPDATE grants SET title = ?, per_txn_limit = ?, daily_limit = ?, monthly_limit = ? WHERE id = ?`).run(
    nextTitle,
    nextPerTxn,
    nextDaily,
    nextMonthly,
    req.params.id
  );

  appendLifecycleAudit(
    db,
    {
      entityId: req.params.id,
      agentId: String(existing.agent_id),
      customerId,
      action: 'grant_edited',
      decision: 'ALLOW',
      details: { grantId: req.params.id, title: nextTitle, nextPerTxn, nextDaily, nextMonthly },
      summary: `Customer updated grant "${nextTitle}" limits (${req.params.id})`,
    },
    now
  );

  broadcastSseEvent('grant:updated', { customerId, grantId: req.params.id });
  res.json({ id: req.params.id, status: 'active' });
});

router.post('/customer/grants/:id/revoke', requireCustomer, (req, res) => {
  const t0 = performance.now();
  const db = getDb();
  const now = Date.now();
  const grantId = req.params.id;
  const customerId = req.user!.customerId!;

  const grant = db.prepare(`SELECT * FROM grants WHERE id = ? AND customer_id = ?`).get(grantId, customerId) as
    | { id: string; title: string; agent_id: string }
    | undefined;
  if (!grant) {
    res.status(404).json({ error: 'Grant not found' });
    return;
  }

  db.transaction(() => {
    db.prepare(`UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?`).run(now, grantId);
    db.prepare(`UPDATE tokens SET status = 'revoked', revoked_at = ? WHERE grant_id = ? AND status IN ('active', 'suspended')`).run(
      now,
      grantId
    );
    appendLifecycleAudit(
      db,
      {
        entityId: grantId,
        agentId: grant.agent_id,
        customerId,
        action: 'grant_revoked',
        decision: 'ALLOW',
        details: { grantId, title: grant.title, revokedAt: now },
        summary: `Customer revoked grant "${grant.title}" (${grantId}) and invalidated associated tokens`,
      },
      now
    );
  })();

  const revokedInMs = Number(Math.max(0.4, performance.now() - t0).toFixed(2));
  broadcastSseEvent('grant:revoked', { customerId, grantId, agentId: grant.agent_id, revokedInMs, timestamp: now });
  res.json({ grantId, status: 'revoked', revokedInMs });
});

const resolveApprovalSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  pin: z.string().min(1).max(12).optional(),
  trustPayee: z.boolean().optional(),
});

router.post('/customer/approvals/:id/resolve', requireCustomer, (req, res) => {
  const parsed = resolveApprovalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid approval decision' });
    return;
  }

  try {
    const result = resolveApproval(getDb(), {
      approvalId: req.params.id,
      decision: parsed.data.decision,
      pin: parsed.data.pin,
      customerId: req.user!.customerId!,
      trustPayee: parsed.data.trustPayee,
    });
    broadcastSseEvent('approval:resolved', {
      approvalId: req.params.id,
      customerId: req.user!.customerId,
      status: result.status,
      bankResult: result.bankResult,
    });
    res.json(result);
  } catch (err) {
    const status = err instanceof ApprovalError ? err.status : 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Approval failed' });
  }
});

const prefsSchema = z.object({
  alwaysAskCustomer: z.boolean().optional(),
  askCustomerOnBlock: z.boolean().optional(),
});

router.post('/customer/settings/preferences', requireCustomer, (req, res) => {
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid preferences' });
    return;
  }
  const db = getDb();
  const now = Date.now();
  const customerId = req.user!.customerId!;
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  if (parsed.data.alwaysAskCustomer !== undefined) {
    upsert.run('always_ask_customer', String(parsed.data.alwaysAskCustomer), now);
  }
  if (parsed.data.askCustomerOnBlock !== undefined) {
    upsert.run('ask_customer_on_block', String(parsed.data.askCustomerOnBlock), now);
  }
  const updated = getSettings(db);

  appendLifecycleAudit(
    db,
    {
      entityId: `prefs_${now}`,
      customerId,
      action: 'approval_preferences_updated',
      decision: 'ALLOW',
      details: {
        alwaysAskCustomer: Boolean(updated.alwaysAskCustomer),
        askCustomerOnBlock: Boolean(updated.askCustomerOnBlock),
      },
      summary: `Customer updated approval preferences (alwaysAskCustomer=${updated.alwaysAskCustomer}, askCustomerOnBlock=${updated.askCustomerOnBlock})`,
    },
    now
  );

  broadcastSseEvent('settings:updated', {
    alwaysAskCustomer: Boolean(updated.alwaysAskCustomer),
    askCustomerOnBlock: Boolean(updated.askCustomerOnBlock),
  });
  res.json({
    alwaysAskCustomer: Boolean(updated.alwaysAskCustomer),
    askCustomerOnBlock: Boolean(updated.askCustomerOnBlock),
  });
});

router.post('/customer/requests/:requestId/escalate-blocked', requireCustomer, (req, res) => {
  try {
    const approval = createHazardousOverrideFromRequest(getDb(), req.params.requestId, req.user!.customerId!);
    broadcastSseEvent('approval:created', { ...approval, action_payload: undefined });
    res.json({ approval: { ...approval, action_payload: undefined, reasons: JSON.parse(approval.reasons || '[]') } });
  } catch (err) {
    const status = err instanceof ApprovalError ? err.status : 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Could not escalate blocked payment' });
  }
});

// --- BANK CONSOLE ROUTES (bank admin only) ---
router.use('/console', requireAdmin);

router.get('/console/overview', (_req, res) => {
  const db = getDb();
  const now = Date.now();
  const dayStart = now - 86_400_000;

  const decisions = db
    .prepare(
      `SELECT d.*, r.agent_id, r.customer_id, r.action, r.category, r.payee_name, r.amount, r.stated_intent, r.provenance, ag.name AS agent_name
       FROM decisions d
       JOIN requests r ON d.request_id = r.id
       LEFT JOIN agents ag ON r.agent_id = ag.id
       ORDER BY d.created_at DESC
       LIMIT 60`
    )
    .all() as Array<Record<string, unknown>>;

  const formattedFeed = decisions.map((row) => {
    const amtPaise = Number(row.amount ?? 0);
    return {
      ...row,
      amount_paise: amtPaise,
      amount: paiseToRupees(amtPaise),
      created_at: Number(row.created_at),
      risk_score: Number(row.risk_score),
      verdict: String(row.verdict),
      agent_id: String(row.agent_id),
      agent_name: row.agent_name ? String(row.agent_name) : null,
      hard_block: Number(row.hard_block || 0),
      reasons: JSON.parse(String(row.reasons || '[]')),
      technical_reasons: JSON.parse(String(row.technical_reasons || '[]')),
      signals: JSON.parse(String(row.signals || '[]')),
      stage_results: JSON.parse(String(row.stage_results || '[]')),
    };
  });

  const actionsToday = decisions.filter((d) => Number(d.created_at) >= dayStart).length;
  const blockedCount = decisions.filter((d) => d.verdict === 'BLOCK').length;
  const escalatedCount = decisions.filter((d) => d.verdict === 'ASK_CUSTOMER').length;
  const avgLatencyMs =
    decisions.length > 0
      ? Number((decisions.reduce((s, d) => s + Number(d.latency_ms || 0), 0) / decisions.length).toFixed(2))
      : 12.4;

  const riskOverTime = formattedFeed
    .slice(0, 20)
    .reverse()
    .map((d, idx) => ({
      index: idx + 1,
      time: new Date(Number(d.created_at)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
      riskScore: Number(d.risk_score),
      verdict: String(d.verdict),
      agent: String(d.agent_name || d.agent_id),
    }));

  const threatCounts = new Map<string, number>();
  for (const d of formattedFeed) {
    if (d.verdict !== 'ALLOW') {
      const sigs = d.signals as Array<{ code?: string }>;
      const key =
        sigs && sigs.length > 0
          ? sigs[0].code || 'POLICY_BLOCK'
          : d.hard_block
          ? 'DELEGATION_OR_IDENTITY'
          : 'BEHAVIOR_ANOMALY';
      threatCounts.set(key, (threatCounts.get(key) || 0) + 1);
    }
  }
  const blocksByThreat = Array.from(threatCounts.entries()).map(([threat, count]) => ({
    threat: threat.replace(/_/g, ' '),
    count,
  }));

  const resolved = db
    .prepare(`SELECT status, created_at, resolved_at FROM approvals WHERE status IN ('approved','denied')`)
    .all() as Array<{ status: string; created_at: number; resolved_at: number | null }>;
  const approvedN = resolved.filter((a) => a.status === 'approved').length;
  const deniedN = resolved.length - approvedN;
  const waits = resolved.filter((a) => a.resolved_at).map((a) => (a.resolved_at as number) - a.created_at);
  const avgWaitMs = waits.length ? waits.reduce((x, y) => x + y, 0) / waits.length : 0;
  const approvalStats = {
    approved: approvedN,
    denied: deniedN,
    falseAlertRate: resolved.length ? `${((approvedN / resolved.length) * 100).toFixed(1)}%` : 'n/a',
    disputeResolutionTime: waits.length
      ? avgWaitMs < 60_000
        ? `${(avgWaitMs / 1000).toFixed(1)} sec`
        : `${(avgWaitMs / 60_000).toFixed(1)} min`
      : 'n/a',
  };

  const agents = db.prepare(`SELECT id, name, publisher, description, public_key, status, risk_tier, created_at FROM agents`).all();
  const alerts = db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 20`).all();
  const settingsRows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));

  res.json({
    kpis: {
      actionsToday,
      totalAnalyzed: decisions.length,
      blockedCount,
      escalatedCount,
      falseAlertRate: approvalStats.falseAlertRate,
      avgLatencyMs,
      disputeResolutionTime: approvalStats.disputeResolutionTime,
      approvals: approvalStats,
    },
    feed: formattedFeed,
    riskOverTime,
    blocksByThreat,
    agents,
    alerts,
    settings,
  });
});

router.post('/console/agents/:id/status', (req, res) => {
  const status = req.body?.status;
  if (!['active', 'suspended', 'quarantined'].includes(status)) {
    res.status(400).json({ error: 'Invalid agent status' });
    return;
  }
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(req.params.id) as { status: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  db.prepare(`UPDATE agents SET status = ? WHERE id = ?`).run(status, req.params.id);
  if (status !== 'active') {
    db.prepare(`UPDATE tokens SET status = 'revoked', revoked_at = ? WHERE agent_id = ? AND status IN ('active', 'suspended')`).run(
      now,
      req.params.id
    );
  }
  appendLifecycleAudit(
    db,
    {
      entityId: req.params.id,
      agentId: req.params.id,
      customerId: 'system',
      action: 'agent_status_changed',
      decision: 'ALLOW',
      details: { agentId: req.params.id, previousStatus: existing.status, newStatus: status, actor: req.user?.email },
      summary: `Admin changed agent ${req.params.id} status from '${existing.status}' to '${status}'`,
    },
    now
  );
  broadcastSseEvent('agent:status', { agentId: req.params.id, status });
  res.json({ agentId: req.params.id, status });
});

const settingsSchema = z.object({
  allow_max_score: z.number().int().min(10).max(60),
  ask_max_score: z.number().int().min(40).max(95),
  approval_expiry_minutes: z.number().int().min(1).max(60).optional(),
  rate_limit_per_minute: z.number().int().min(5).max(500).optional(),
});

router.post('/console/settings', (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success || parsed.data.allow_max_score >= parsed.data.ask_max_score) {
    res.status(400).json({ error: 'Invalid threshold configuration (allow_max_score must be < ask_max_score)' });
    return;
  }
  const db = getDb();
  const now = Date.now();
  const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`);
  upsert.run('allow_max_score', String(parsed.data.allow_max_score), now);
  upsert.run('ask_max_score', String(parsed.data.ask_max_score), now);
  if (parsed.data.approval_expiry_minutes) {
    upsert.run('approval_expiry_minutes', String(parsed.data.approval_expiry_minutes), now);
  }
  if (parsed.data.rate_limit_per_minute) {
    upsert.run('rate_limit_per_minute', String(parsed.data.rate_limit_per_minute), now);
  }

  appendLifecycleAudit(
    db,
    {
      entityId: `settings_${now}`,
      customerId: 'system',
      action: 'settings_updated',
      decision: 'ALLOW',
      details: { ...parsed.data, actor: req.user?.email },
      summary: `Admin updated risk thresholds (allow <= ${parsed.data.allow_max_score}, ask <= ${parsed.data.ask_max_score})`,
    },
    now
  );

  broadcastSseEvent('settings:updated', parsed.data);
  res.json({ ok: true, settings: parsed.data });
});

// --- AUDIT EXPLORER ROUTES ---
router.get('/audit/logs', requireUser, (req, res) => {
  const db = getDb();
  const scope = req.user!.role === 'bank_admin' ? null : req.user!.customerId;
  const decisionFilter = typeof req.query.decision === 'string' ? req.query.decision : '';
  const search = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

  const rows = db
    .prepare(
      `SELECT a.*, ag.name AS agent_name
       FROM audit_log a
       LEFT JOIN agents ag ON a.agent_id = ag.id
       WHERE (? IS NULL OR a.customer_id = ?)
       ORDER BY a.seq DESC
       LIMIT 150`
    )
    .all(scope, scope) as Array<Record<string, unknown>>;

  const formatted = rows
    .map((r) => ({
      ...r,
      id: String(r.id),
      agent_id: String(r.agent_id),
      agent_name: r.agent_name ? String(r.agent_name) : '',
      action: String(r.action),
      decision: String(r.decision),
      reasons: JSON.parse(String(r.reasons || '[]')),
      stage_results: JSON.parse(String(r.stage_results || '[]')),
    }))
    .filter((r) => {
      if (decisionFilter && decisionFilter !== 'ALL' && r.decision !== decisionFilter) return false;
      if (search) {
        const hay = `${r.id} ${r.agent_id} ${r.agent_name} ${r.action} ${r.decision} ${JSON.stringify(r.reasons)}`.toLowerCase();
        return hay.includes(search);
      }
      return true;
    });

  res.json({ entries: formatted });
});

let verifyCache: { at: number; result: ReturnType<typeof verifyAuditChain> } | null = null;
router.post('/audit/verify', requireUser, (_req, res) => {
  if (!verifyCache || Date.now() - verifyCache.at > 5_000) {
    verifyCache = { at: Date.now(), result: verifyAuditChain(getDb()) };
  }
  res.json(verifyCache.result);
});

router.get('/audit/anchor', requireUser, (_req, res) => {
  try {
    const anchor = exportAuditAnchor(getDb());
    res.json(anchor);
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Could not export audit anchor' });
  }
});

const verifyAnchorSchema = z.object({
  version: z.literal(1),
  exportedAt: z.number().finite(),
  entryCount: z.number().int().positive(),
  firstSeq: z.number().int().positive(),
  lastSeq: z.number().int().positive(),
  lastEntryId: z.string().min(1),
  lastHash: z.string().length(64),
  hmacSig: z.string().length(64),
  anchorDigest: z.string().length(64),
});

router.post('/audit/verify-anchor', requireUser, (req, res) => {
  const parsed = verifyAnchorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid external audit anchor format', issues: parsed.error.issues });
    return;
  }
  const result = verifyAuditAgainstAnchor(getDb(), parsed.data);
  res.json(result);
});

router.post('/audit/simulate-tamper', requireDemoMode, requireUser, (_req, res) => {
  try {
    const tampered = simulateAuditTampering(getDb());
    verifyCache = null;
    broadcastSseEvent('audit:tampered', tampered);
    res.json(tampered);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Tamper simulation failed' });
  }
});

// --- SELFTEST & RESET DEMO & OPENAPI DOCS ---
router.get('/selftest', (req, res, next) => (isDemoMode() ? next() : requireAdmin(req, res, next)), async (_req, res) => {
  const report = await runFullSelfTest();
  res.json(report);
});

router.get('/benchmark', (req, res, next) => (isDemoMode() ? next() : requireAdmin(req, res, next)), async (_req, res) => {
  const saved = loadSavedBenchmarkSummary(process.cwd());
  if (saved) {
    res.json(saved);
    return;
  }
  const fresh = await generateAndSaveBenchmarkReport(process.cwd());
  res.json(fresh);
});

router.post('/reset-demo', requireDemoMode, requireUser, (_req, res) => {
  resetAndSeedDatabase(getDb());
  verifyCache = null;
  broadcastSseEvent('demo:reset', { timestamp: Date.now() });
  res.json({ ok: true, message: 'Demo database reset to clean 30-day Indian banking baseline.' });
});

router.get('/docs', (_req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'AgentShield Security Gateway API',
      version: '1.0.0',
      description: 'Zero-trust 5-stage security gateway between AI Agents and Banking APIs.',
    },
    paths: {
      '/api/gateway/tokens': {
        post: {
          summary: 'Issue fingerprint-bound short-lived delegation JWT',
          requestBody: { required: true },
          responses: { '200': { description: 'Signed HS256 JWT + jti' } },
        },
      },
      '/api/gateway/tokens/{jti}/reissue': {
        post: {
          summary: 'Re-issue a fresh delegation token replacing a suspended one',
          responses: { '200': { description: 'New JWT + jti replacing old jti' } },
        },
      },
      '/api/gateway/session/start': {
        post: {
          summary: 'Register customer-corroborated stated intent before handing control to an agent',
          responses: { '201': { description: 'Registered sessionId bound to customer & agent' } },
        },
      },
      '/api/gateway/execute': {
        post: {
          summary: 'Execute banking action through 5-stage AgentShield pipeline',
          requestBody: { required: true },
          responses: { '200': { description: 'Decision { verdict, riskScore, reasons, stageResults }' } },
        },
      },
      '/api/gateway/requests/{id}': {
        get: {
          summary: 'Poll or long-poll status of an escalated ASK_CUSTOMER request',
          parameters: [{ name: 'wait', in: 'query', schema: { type: 'boolean' } }],
          responses: { '200': { description: 'Request, Decision, and Approval status' } },
        },
      },
      '/api/audit/verify': {
        post: {
          summary: 'Recompute SHA-256 + HMAC hash chain over entire audit_log table',
          responses: { '200': { description: 'Chain verification integrity report' } },
        },
      },
      '/api/audit/anchor': {
        get: {
          summary: 'Export signed external audit head anchor for out-of-band storage',
          responses: { '200': { description: 'Signed ExternalAuditAnchor JSON' } },
        },
      },
    },
  });
});

export default router;
