import type Database from 'better-sqlite3';
import type { GatewayExecuteRequest, StageResult } from '../types.ts';
import { formatInrFromPaise, paiseToRupees, tryRupeesToPaise } from '../money.ts';

export interface GrantRow {
  id: string;
  customer_id: string;
  agent_id: string;
  title: string;
  allowed_actions: string;
  allowed_categories: string;
  payee_allowlist: string;
  per_txn_limit: number; // integer paise
  daily_limit: number; // integer paise
  monthly_limit: number; // integer paise
  valid_from: number;
  valid_until: number;
  allowed_hours: string | null;
  status: 'active' | 'revoked' | 'expired';
  revoked_at: number | null;
}

export interface Stage2Output {
  passed: boolean;
  hardBlock: boolean;
  grant?: GrantRow;
  amountPaise?: number;
  customerReason?: string;
  technicalReason?: string;
  threatType?: string;
  revokedProofMs?: number;
  stageResult: StageResult;
}

export function runStage2Delegation(
  db: Database.Database,
  req: GatewayExecuteRequest,
  context: { agentId: string; customerId: string; grantId: string },
  now: number = Date.now()
): Stage2Output {
  const t0 = performance.now();

  const fail = (
    customerReason: string,
    technicalReason: string,
    threatType: string,
    revokedProofMs?: number,
    extra: Record<string, unknown> = {}
  ): Stage2Output => ({
    passed: false,
    hardBlock: true,
    customerReason,
    technicalReason,
    threatType,
    revokedProofMs,
    stageResult: {
      stage: 2,
      name: 'Scoped Delegation',
      status: 'FAIL',
      latencyMs: Number((performance.now() - t0).toFixed(2)),
      summary: technicalReason,
      details: { threatType, revokedProofMs, ...extra },
    },
  });

  const grant = db
    .prepare(`SELECT * FROM grants WHERE id = ? AND customer_id = ? AND agent_id = ?`)
    .get(context.grantId, context.customerId, context.agentId) as GrantRow | undefined;

  if (!grant) {
    return fail(
      'Default deny: no active permission grant covers this agent.',
      `No matching grant found for grant_id=${context.grantId}`,
      'no_grant'
    );
  }

  if (grant.status === 'revoked') {
    const revokedMs = grant.revoked_at ? Math.max(1, now - grant.revoked_at) : 1;
    return fail(
      `Blocked immediately because you revoked "${grant.title}".`,
      `Grant ${grant.id} status='revoked' (enforced ${revokedMs}ms after revocation)`,
      'revoked_grant',
      revokedMs,
      { grantId: grant.id }
    );
  }

  if (grant.status === 'expired' || now > grant.valid_until || now < grant.valid_from) {
    return fail(
      `This permission ("${grant.title}") has expired.`,
      `Grant ${grant.id} expired at ${new Date(grant.valid_until).toISOString()}`,
      'expired_grant',
      undefined,
      { validUntil: grant.valid_until }
    );
  }

  const allowedActions: string[] = JSON.parse(grant.allowed_actions || '[]');
  const allowedCategories: string[] = JSON.parse(grant.allowed_categories || '[]');
  const payeeAllowlist: string[] = JSON.parse(grant.payee_allowlist || '[]');

  // Action check (default deny)
  if (!allowedActions.includes(req.action)) {
    return fail(
      `Blocked: this agent only has permission for [${allowedActions.join(', ')}], not "${req.action}".`,
      `Over-permissioned action '${req.action}' denied by grant ${grant.id} (allowed: ${allowedActions.join(', ')})`,
      'over_permissioned',
      undefined,
      { requestedAction: req.action, allowedActions }
    );
  }

  // Read-only actions pass after action check
  if (req.action === 'check_balance') {
    return {
      passed: true,
      hardBlock: false,
      grant,
      amountPaise: 0,
      stageResult: {
        stage: 2,
        name: 'Scoped Delegation',
        status: 'PASS',
        latencyMs: Number((performance.now() - t0).toFixed(2)),
        summary: `Read action 'check_balance' permitted under "${grant.title}"`,
        details: { grantId: grant.id, allowedActions },
      },
    };
  }

  // Category check for write actions
  let resolvedCategory = req.params.category;
  if (req.params.payeeId) {
    const pRow = db
      .prepare(`SELECT category FROM payees WHERE id = ? AND customer_id = ?`)
      .get(req.params.payeeId, context.customerId) as { category: string } | undefined;
    if (pRow) {
      if (req.params.category && req.params.category !== pRow.category) {
        return fail(
          `Blocked: the agent claimed category "${req.params.category}" but this payee is registered as "${pRow.category}".`,
          `Declared category '${req.params.category}' contradicts payee ${req.params.payeeId} category '${pRow.category}'`,
          'category_violation',
          undefined,
          { declaredCategory: req.params.category, payeeCategory: pRow.category }
        );
      }
      resolvedCategory = pRow.category;
    }
  }
  resolvedCategory = resolvedCategory || 'transfer';

  if (allowedCategories.length > 0 && !allowedCategories.includes(resolvedCategory)) {
    return fail(
      `Blocked: agent is only permitted for categories [${allowedCategories.join(', ')}], not "${resolvedCategory}".`,
      `Category '${resolvedCategory}' outside grant ${grant.id} allowed categories [${allowedCategories.join(', ')}]`,
      'category_violation',
      undefined,
      { requestedCategory: resolvedCategory, allowedCategories }
    );
  }

  if (req.action === 'add_payee') {
    return {
      passed: true,
      hardBlock: false,
      grant,
      amountPaise: 0,
      stageResult: {
        stage: 2,
        name: 'Scoped Delegation',
        status: 'PASS',
        latencyMs: Number((performance.now() - t0).toFixed(2)),
        summary: `Action 'add_payee' permitted under "${grant.title}" (customer approval required downstream)`,
        details: { grantId: grant.id, category: resolvedCategory },
      },
    };
  }

  if (payeeAllowlist.length > 0 && (!req.params.payeeId || !payeeAllowlist.includes(req.params.payeeId))) {
    return fail(
      `Blocked: payee is not on your approved allowlist for this agent.`,
      `Payee '${req.params.payeeId ?? '(none given)'}' not in grant ${grant.id} payee_allowlist`,
      'payee_not_allowed',
      undefined,
      { payeeId: req.params.payeeId ?? null, payeeAllowlist }
    );
  }

  // Amount checks for pay_bill / transfer in exact integer paise
  const amountPaise = tryRupeesToPaise(req.params.amount);
  if (amountPaise === null || amountPaise <= 0) {
    return fail(
      'Invalid payment amount.',
      `Amount ${req.params.amount} must be a positive number with at most 2 decimals`,
      'invalid_amount'
    );
  }

  if (amountPaise > grant.per_txn_limit) {
    return fail(
      `Blocked: ${formatInrFromPaise(amountPaise)} exceeds your ${formatInrFromPaise(grant.per_txn_limit)} per-transaction limit.`,
      `Amount ${formatInrFromPaise(amountPaise)} exceeds grant ${grant.id} per_txn_limit ${formatInrFromPaise(grant.per_txn_limit)}`,
      'limit_exceeded',
      undefined,
      { amount: paiseToRupees(amountPaise), amountPaise, perTxnLimitPaise: grant.per_txn_limit }
    );
  }

  // Compute cumulative daily & monthly spend in integer paise from real ledger transactions
  const dayStart = now - 86_400_000;
  const monthStart = now - 30 * 86_400_000;

  const dailyRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE customer_id = ? AND agent_id = ? AND status = 'completed' AND created_at >= ?`
    )
    .get(context.customerId, context.agentId, dayStart) as { total: number };

  const monthlyRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE customer_id = ? AND agent_id = ? AND status = 'completed' AND created_at >= ?`
    )
    .get(context.customerId, context.agentId, monthStart) as { total: number };

  if (dailyRow.total + amountPaise > grant.daily_limit) {
    return fail(
      `Blocked: this payment would bring today's agent spend to ${formatInrFromPaise(dailyRow.total + amountPaise)}, exceeding your ${formatInrFromPaise(grant.daily_limit)} daily cap.`,
      `Daily cap exceeded: spent ${dailyRow.total} + ${amountPaise} > ${grant.daily_limit} paise`,
      'daily_limit_exceeded',
      undefined,
      { dailySpentPaise: dailyRow.total, amountPaise, dailyLimitPaise: grant.daily_limit }
    );
  }

  if (monthlyRow.total + amountPaise > grant.monthly_limit) {
    return fail(
      `Blocked: monthly limit of ${formatInrFromPaise(grant.monthly_limit)} would be exceeded.`,
      `Monthly cap exceeded: spent ${monthlyRow.total} + ${amountPaise} > ${grant.monthly_limit} paise`,
      'monthly_limit_exceeded',
      undefined,
      { monthlySpentPaise: monthlyRow.total, amountPaise, monthlyLimitPaise: grant.monthly_limit }
    );
  }

  return {
    passed: true,
    hardBlock: false,
    grant,
    amountPaise,
    stageResult: {
      stage: 2,
      name: 'Scoped Delegation',
      status: 'PASS',
      latencyMs: Number((performance.now() - t0).toFixed(2)),
      summary: `Within "${grant.title}" (${formatInrFromPaise(amountPaise)} <= ${formatInrFromPaise(grant.per_txn_limit)} cap)`,
      details: {
        grantId: grant.id,
        category: resolvedCategory,
        amount: paiseToRupees(amountPaise),
        amountPaise,
        dailySpentPaise: dailyRow.total,
        dailyLimitPaise: grant.daily_limit,
        monthlySpentPaise: monthlyRow.total,
        monthlyLimitPaise: grant.monthly_limit,
      },
    },
  };
}
