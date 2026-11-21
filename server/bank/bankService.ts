import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { getDb } from '../db/database.ts';
import { constantTimeEqual, verifyBankExecutionAuth } from '../gateway/crypto.ts';
import { getSecret } from '../config.ts';
import { paiseToRupees, rupeesToPaise, tryRupeesToPaise } from '../money.ts';

export function getBankInternalSecret(): string {
  return getSecret('BANK_INTERNAL_SECRET');
}

export function verifyBankGatewaySecret(providedSecret: string | undefined): boolean {
  if (!providedSecret) return false;
  return constantTimeEqual(providedSecret, getBankInternalSecret());
}

/** Hard independent per-transaction ceiling enforced by the bank core regardless of gateway grants. */
export function getBankMaxTxnPaise(): number {
  const raw = Number(process.env.BANK_MAX_TXN_RUPEES ?? 100_000);
  if (Number.isFinite(raw) && raw > 0) {
    return rupeesToPaise(raw);
  }
  return rupeesToPaise(100_000);
}

export class BankService {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDb();
  }

  getAccountSummary(customerId: string) {
    const customer = this.db.prepare(`SELECT id, name, email, city, timezone FROM customers WHERE id = ?`).get(customerId);
    const rawAccounts = this.db
      .prepare(`SELECT id, customer_id, account_number, account_type, currency, balance, updated_at FROM accounts WHERE customer_id = ?`)
      .all(customerId) as Array<{
      id: string;
      customer_id: string;
      account_number: string;
      account_type: string;
      currency: string;
      balance: number;
      updated_at: number;
    }>;
    const accounts = rawAccounts.map((acc) => ({
      ...acc,
      balance_paise: acc.balance,
      balance: paiseToRupees(acc.balance),
    }));

    const payees = this.db
      .prepare(`SELECT id, customer_id, name, vpa, category, verified, created_at FROM payees WHERE customer_id = ? ORDER BY created_at DESC`)
      .all(customerId);

    const rawTransactions = this.db
      .prepare(`SELECT * FROM transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 25`)
      .all(customerId) as Array<Record<string, unknown>>;
    const recentTransactions = rawTransactions.map((tx) => ({
      ...tx,
      amount_paise: Number(tx.amount),
      amount: paiseToRupees(Number(tx.amount)),
    }));

    return { customer, accounts, payees, recentTransactions };
  }

  executeAuthorizedAction(input: {
    customerId: string;
    agentId: string;
    action: 'check_balance' | 'pay_bill' | 'transfer' | 'add_payee';
    accountId?: string;
    payeeId?: string;
    payeeName?: string;
    payeeVpa?: string;
    category?: string;
    /** Amount in rupees (API boundary); converted to exact integer paise internally. */
    amount?: number;
    /** Exact integer paise if already converted by gateway. */
    amountPaise?: number;
    note?: string;
    idempotencyKey?: string;
    gatewayAuth?: string;
    requireGatewayAuth?: boolean;
  }): Record<string, unknown> {
    const customerExists = this.db.prepare(`SELECT id FROM customers WHERE id = ?`).get(input.customerId);
    if (!customerExists) {
      throw new Error('Customer account holder does not exist');
    }

    const resolvedAmountPaise =
      input.action === 'check_balance' || input.action === 'add_payee'
        ? 0
        : input.amountPaise !== undefined
        ? input.amountPaise
        : tryRupeesToPaise(input.amount ?? 0);

    if (input.action === 'pay_bill' || input.action === 'transfer') {
      if (resolvedAmountPaise === null || !Number.isSafeInteger(resolvedAmountPaise) || resolvedAmountPaise <= 0) {
        throw new Error('Invalid payment amount (must be positive integer paise / max 2 decimal rupees)');
      }
      const bankMaxPaise = getBankMaxTxnPaise();
      if (resolvedAmountPaise > bankMaxPaise) {
        throw new Error(
          `Bank core hard limit exceeded: ₹${paiseToRupees(resolvedAmountPaise).toLocaleString('en-IN')} > bank ceiling ₹${paiseToRupees(bankMaxPaise).toLocaleString('en-IN')}`
        );
      }
    }

    if (input.requireGatewayAuth || input.gatewayAuth !== undefined) {
      const authCheck = verifyBankExecutionAuth(input.gatewayAuth, {
        customerId: input.customerId,
        agentId: input.agentId,
        action: input.action,
        amountPaise: resolvedAmountPaise ?? 0,
        payeeId: input.payeeId ?? null,
        idempotencyKey: input.idempotencyKey,
      });
      if (!authCheck.valid) {
        throw new Error(authCheck.reason || 'Invalid gateway execution authorization');
      }
    }

    const account = (input.accountId
      ? this.db.prepare(`SELECT * FROM accounts WHERE id = ? AND customer_id = ?`).get(input.accountId, input.customerId)
      : this.db.prepare(`SELECT * FROM accounts WHERE customer_id = ? ORDER BY account_type, id LIMIT 1`).get(input.customerId)) as
      | { id: string; account_number: string; balance: number; currency: string }
      | undefined;

    if (!account) {
      throw new Error('Customer bank account not found');
    }

    if (input.action === 'check_balance') {
      return {
        status: 'executed',
        action: 'check_balance',
        accountNumber: account.account_number,
        currency: account.currency,
        balance: paiseToRupees(account.balance),
        balancePaise: account.balance,
        checkedAt: Date.now(),
      };
    }

    if (input.action === 'add_payee') {
      const id = `payee_${crypto.randomBytes(4).toString('hex')}`;
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO payees (id, customer_id, name, vpa, category, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.customerId, input.payeeName || 'New Payee', input.payeeVpa || 'unknown@upi', input.category || 'general', 0, now);

      return {
        status: 'executed',
        action: 'add_payee',
        payeeId: id,
        payeeName: input.payeeName || 'New Payee',
        vpa: input.payeeVpa || 'unknown@upi',
      };
    }

    const amountPaise = resolvedAmountPaise as number;

    if (input.idempotencyKey) {
      const existing = this.db
        .prepare(`SELECT * FROM transactions WHERE idempotency_key = ?`)
        .get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.customer_id !== input.customerId || existing.agent_id !== input.agentId) {
          throw new Error('Idempotency key already used');
        }
        const amtPaise = Number(existing.amount);
        return {
          status: 'executed_idempotent',
          transactionId: existing.id,
          amount: paiseToRupees(amtPaise),
          amountPaise: amtPaise,
          payeeName: existing.payee_name,
          newBalance: paiseToRupees(account.balance),
          newBalancePaise: account.balance,
          idempotentReplay: true,
        };
      }
    }

    return this.db.transaction(() => {
      const freshAcc = this.db
        .prepare(`SELECT balance FROM accounts WHERE id = ?`)
        .get(account.id) as { balance: number };

      if (freshAcc.balance < amountPaise) {
        throw new Error('Insufficient bank balance');
      }

      const newBalancePaise = freshAcc.balance - amountPaise;
      const now = Date.now();
      this.db
        .prepare(`UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?`)
        .run(newBalancePaise, now, account.id);

      let resolvedPayeeName = input.payeeName || 'External Recipient';
      let resolvedCategory = input.category || 'transfer';
      if (input.payeeId) {
        const payeeRow = this.db
          .prepare(`SELECT name, category FROM payees WHERE id = ? AND customer_id = ?`)
          .get(input.payeeId, input.customerId) as { name: string; category: string } | undefined;
        if (payeeRow) {
          resolvedPayeeName = payeeRow.name;
          resolvedCategory = payeeRow.category;
        }
      }

      const txnId = `txn_${crypto.randomBytes(5).toString('hex')}`;
      this.db
        .prepare(
          `INSERT INTO transactions (id, account_id, customer_id, agent_id, payee_id, payee_name, category, action, amount, status, idempotency_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          txnId,
          account.id,
          input.customerId,
          input.agentId,
          input.payeeId ?? null,
          resolvedPayeeName,
          resolvedCategory,
          input.action,
          amountPaise,
          'completed',
          input.idempotencyKey ?? `idem_${txnId}`,
          input.note ?? `Authorized via AgentShield`,
          now
        );

      return {
        status: 'executed',
        transactionId: txnId,
        action: input.action,
        amount: paiseToRupees(amountPaise),
        amountPaise,
        payeeName: resolvedPayeeName,
        category: resolvedCategory,
        newBalance: paiseToRupees(newBalancePaise),
        newBalancePaise,
        executedAt: now,
      };
    })();
  }
}
