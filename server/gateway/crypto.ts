import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getSecret } from '../config.ts';
import type { DeviceFingerprint } from '../types.ts';

function getJwtSecretBytes(): Uint8Array {
  return new TextEncoder().encode(getSecret('AGENTSHIELD_JWT_SECRET'));
}

function getAuditHmacKey(): string {
  return getSecret('AGENTSHIELD_AUDIT_HMAC_KEY');
}

/**
 * Separate signing key for gateway -> bank execution authorization tokens.
 * Cannot be derived from BANK_INTERNAL_SECRET alone.
 */
function getBankAuthSigningKey(): string {
  const explicit = process.env.AGENTSHIELD_BANK_AUTH_KEY;
  if (explicit && explicit.length >= 24) {
    return explicit;
  }
  return sha256Hex(`agentshield-bank-exec-auth|${getSecret('AGENTSHIELD_JWT_SECRET')}`);
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Burn comparable time before returning false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function computeFingerprintHash(fp: DeviceFingerprint): string {
  const normalized = `${fp.agentRuntimeId}|${fp.ip}|${fp.asn}|${sha256Hex(fp.userAgent)}`;
  return sha256Hex(normalized);
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeEntryHash(prevHash: string, entryPayload: Record<string, unknown>): string {
  return sha256Hex(`${prevHash}|${canonicalJson(entryPayload)}`);
}

export function signAuditHmac(entryHash: string): string {
  return crypto.createHmac('sha256', getAuditHmacKey()).update(entryHash).digest('hex');
}

export function verifyAuditHmac(entryHash: string, providedHmac: string): boolean {
  if (!providedHmac || typeof providedHmac !== 'string') return false;
  return constantTimeEqual(signAuditHmac(entryHash), providedHmac);
}

export interface BankExecutionAuthClaims {
  requestId: string;
  customerId: string;
  agentId: string;
  action: 'check_balance' | 'pay_bill' | 'transfer' | 'add_payee';
  amountPaise: number;
  payeeId: string | null;
  idempotencyKey: string;
  iat: number;
  exp: number;
}

export function signBankExecutionAuth(
  params: {
    requestId: string;
    customerId: string;
    agentId: string;
    action: 'check_balance' | 'pay_bill' | 'transfer' | 'add_payee';
    amountPaise: number;
    payeeId?: string | null;
    idempotencyKey: string;
  },
  ttlMs: number = 30_000,
  now: number = Date.now()
): string {
  const claims: BankExecutionAuthClaims = {
    requestId: params.requestId,
    customerId: params.customerId,
    agentId: params.agentId,
    action: params.action,
    amountPaise: Math.trunc(params.amountPaise),
    payeeId: params.payeeId ?? null,
    idempotencyKey: params.idempotencyKey,
    iat: now,
    exp: now + ttlMs,
  };
  const payloadB64 = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url');
  const sigHex = crypto.createHmac('sha256', getBankAuthSigningKey()).update(payloadB64).digest('hex');
  return `${payloadB64}.${sigHex}`;
}

export function verifyBankExecutionAuth(
  token: string | undefined,
  expected: {
    customerId: string;
    agentId: string;
    action: string;
    amountPaise: number;
    payeeId?: string | null;
    idempotencyKey?: string;
  },
  now: number = Date.now()
): { valid: boolean; reason?: string; claims?: BankExecutionAuthClaims } {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'Missing gateway execution authorization token' };
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: 'Malformed gateway execution authorization token' };
  }
  const [payloadB64, providedSig] = parts;
  const expectedSig = crypto.createHmac('sha256', getBankAuthSigningKey()).update(payloadB64).digest('hex');
  if (!constantTimeEqual(providedSig, expectedSig)) {
    return { valid: false, reason: 'Invalid gateway execution authorization signature' };
  }

  let claims: BankExecutionAuthClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as BankExecutionAuthClaims;
  } catch {
    return { valid: false, reason: 'Unreadable gateway execution authorization payload' };
  }

  if (
    typeof claims.requestId !== 'string' ||
    typeof claims.customerId !== 'string' ||
    typeof claims.agentId !== 'string' ||
    typeof claims.action !== 'string' ||
    !Number.isSafeInteger(claims.amountPaise) ||
    typeof claims.idempotencyKey !== 'string' ||
    !Number.isFinite(claims.iat) ||
    !Number.isFinite(claims.exp)
  ) {
    return { valid: false, reason: 'Incomplete gateway execution authorization claims' };
  }

  if (now > claims.exp || claims.iat > now + 5_000) {
    return { valid: false, reason: 'Gateway execution authorization token expired' };
  }

  if (
    claims.customerId !== expected.customerId ||
    claims.agentId !== expected.agentId ||
    claims.action !== expected.action ||
    claims.amountPaise !== Math.trunc(expected.amountPaise) ||
    (claims.payeeId ?? null) !== (expected.payeeId ?? null)
  ) {
    return { valid: false, reason: 'Gateway authorization claims do not match execution payload' };
  }

  if (expected.idempotencyKey && claims.idempotencyKey !== expected.idempotencyKey) {
    return { valid: false, reason: 'Gateway authorization idempotency key mismatch' };
  }

  return { valid: true, claims };
}

export interface DelegationJwtPayload {
  agent_id: string;
  customer_id: string;
  grant_id: string;
  jti: string;
  fp_hash: string;
  exp?: number;
  iat?: number;
}

export async function signDelegationToken(params: {
  agentId: string;
  customerId: string;
  grantId: string;
  jti: string;
  fingerprint: DeviceFingerprint;
  ttlSeconds?: number;
}): Promise<{ token: string; expiresAt: number; fingerprintHash: string }> {
  const ttl = params.ttlSeconds ?? 900; // 15 minutes short-lived default
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + ttl;
  const fpHash = computeFingerprintHash(params.fingerprint);

  const token = await new SignJWT({
    agent_id: params.agentId,
    customer_id: params.customerId,
    grant_id: params.grantId,
    fp_hash: fpHash,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setJti(params.jti)
    .setIssuedAt(nowSec)
    .setExpirationTime(expSec)
    .setIssuer('agentshield.gateway')
    .sign(getJwtSecretBytes());

  return {
    token,
    expiresAt: expSec * 1000,
    fingerprintHash: fpHash,
  };
}

export async function verifyDelegationToken(token: string): Promise<DelegationJwtPayload> {
  const { payload } = await jwtVerify(token, getJwtSecretBytes(), {
    issuer: 'agentshield.gateway',
    algorithms: ['HS256'],
  });

  if (
    typeof payload.agent_id !== 'string' ||
    typeof payload.customer_id !== 'string' ||
    typeof payload.grant_id !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof payload.fp_hash !== 'string'
  ) {
    throw new Error('Malformed delegation token claims');
  }

  return {
    agent_id: payload.agent_id,
    customer_id: payload.customer_id,
    grant_id: payload.grant_id,
    jti: payload.jti,
    fp_hash: payload.fp_hash,
    exp: payload.exp,
    iat: payload.iat,
  };
}

/** Salted scrypt hash for passwords and PINs. Format: scrypt$<salt>$<hash> */
export function hashSecret(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifySecret(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(plain, parts[1], expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
