import { Router } from 'express';
import { z } from 'zod';
import { BankService, verifyBankGatewaySecret } from '../bank/bankService.ts';
import { verifyBankExecutionAuth } from '../gateway/crypto.ts';
import { getDb } from '../db/database.ts';
import { tryRupeesToPaise } from '../money.ts';

const router = Router();

// Middleware: Mock Bank trusts ONLY requests carrying the AgentShield Gateway internal secret
router.use((req, res, next) => {
  const secret = req.header('x-bank-internal-secret');
  if (!verifyBankGatewaySecret(secret)) {
    res.status(403).json({
      error: 'Direct access to Mock Bank API forbidden',
      code: 'GATEWAY_SECRET_REQUIRED',
      message: 'Agents cannot call /api/bank/* directly. All requests must pass through /api/gateway/execute.',
    });
    return;
  }
  next();
});

router.get('/accounts/:customerId', (req, res) => {
  try {
    const bank = new BankService(getDb());
    const summary = bank.getAccountSummary(req.params.customerId);
    res.json(summary);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Customer not found' });
  }
});

const executeSchema = z.object({
  customerId: z.string().min(1),
  agentId: z.string().min(1),
  action: z.enum(['check_balance', 'pay_bill', 'transfer', 'add_payee']),
  accountId: z.string().optional(),
  payeeId: z.string().optional(),
  payeeName: z.string().optional(),
  payeeVpa: z.string().optional(),
  category: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  amountPaise: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

router.post('/execute', (req, res) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid bank execution payload', issues: parsed.error.issues });
    return;
  }

  const data = parsed.data;
  const amountPaise =
    data.action === 'check_balance' || data.action === 'add_payee'
      ? 0
      : data.amountPaise !== undefined
      ? data.amountPaise
      : tryRupeesToPaise(data.amount ?? 0);

  if (amountPaise === null) {
    res.status(400).json({ error: 'Invalid payment amount precision', code: 'INVALID_AMOUNT' });
    return;
  }

  // Defense-in-depth: internal secret alone cannot move money or query accounts; require short-lived
  // signed gateway execution authorization bound to the exact transaction parameters.
  const gatewayAuth = req.header('x-bank-authorization');
  const authCheck = verifyBankExecutionAuth(gatewayAuth, {
    customerId: data.customerId,
    agentId: data.agentId,
    action: data.action,
    amountPaise,
    payeeId: data.payeeId ?? null,
    idempotencyKey: data.idempotencyKey,
  });

  if (!authCheck.valid) {
    res.status(403).json({
      error: 'Valid gateway execution authorization required',
      code: 'BANK_AUTH_REQUIRED',
      message: authCheck.reason || 'Signed x-bank-authorization header missing or does not match payload.',
    });
    return;
  }

  try {
    const bank = new BankService(getDb());
    const result = bank.executeAuthorizedAction({
      ...data,
      amountPaise,
      gatewayAuth,
      requireGatewayAuth: true,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bank execution failed' });
  }
});

export default router;
