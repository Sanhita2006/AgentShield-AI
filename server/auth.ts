import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getSecret, isDemoMode, isProd } from './config.ts';
import { getDb } from './db/database.ts';
import type { UserRole } from './types.ts';

export const SESSION_COOKIE = 'agentshield_session';
const SESSION_TTL_MS = 12 * 3_600_000;

export interface SessionPayload {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  customerId: string | null;
  exp: number;
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', getSecret('SESSION_SECRET')).update(data).digest('base64url');
}

export function signSession(payload: Omit<SessionPayload, 'exp'>): string {
  const full: SessionPayload = { ...payload, exp: Date.now() + SESSION_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return `${b64}.${hmac(b64)}`;
}

function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [b64, sig, extra] = token.split('.');
  if (!b64 || !sig || extra !== undefined) return null;
  const expected = Buffer.from(hmac(b64));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as SessionPayload;
    return parsed.exp > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, payload: Omit<SessionPayload, 'exp'>): SessionPayload {
  const req = res.req;
  const isHttps = isProd() || Boolean(req?.secure || req?.headers['x-forwarded-proto'] === 'https');
  res.cookie(SESSION_COOKIE, signSession(payload), {
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    maxAge: SESSION_TTL_MS,
  });
  return { ...payload, exp: Date.now() + SESSION_TTL_MS };
}

/** Preview customer so signed-out visitors can explore the demo. Only exists in DEMO_MODE. */
const DEMO_PREVIEW: Omit<SessionPayload, 'exp'> = {
  userId: 'user_arjun',
  email: 'arjun.sen@example.in',
  name: 'Arjun Sen',
  role: 'customer',
  customerId: 'cust_arjun_sen',
};

/**
 * A signed cookie alone can't be revoked, so confirm the account still exists with the same role
 * and customer link. Deleted users / changed roles lose access immediately.
 */
function sessionStillValid(s: SessionPayload): boolean {
  try {
    const row = getDb().prepare(`SELECT role, customer_id FROM users WHERE id = ?`).get(s.userId) as
      | { role: string; customer_id: string | null }
      | undefined;
    return Boolean(row) && row!.role === s.role && (row!.customer_id ?? null) === (s.customerId ?? null);
  } catch {
    return false;
  }
}

export function getCurrentUser(req: Request): SessionPayload | null {
  const verified = verifySession(req.cookies?.[SESSION_COOKIE] as string | undefined);
  if (verified && sessionStillValid(verified)) return verified;
  if (isDemoMode()) return { ...DEMO_PREVIEW, exp: Date.now() + 86_400_000 };
  return null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionPayload;
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const user = getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }
  req.user = user;
  next();
}

export function requireCustomer(req: Request, res: Response, next: NextFunction): void {
  requireUser(req, res, () => {
    if (req.user?.role !== 'customer' || !req.user.customerId) {
      res.status(403).json({ error: 'Customer session required' });
      return;
    }
    next();
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireUser(req, res, () => {
    if (req.user?.role !== 'bank_admin') {
      res.status(403).json({ error: 'Bank Admin session required' });
      return;
    }
    next();
  });
}

export function requireDemoMode(_req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

/** CSRF guard for cookie-authenticated routes: a browser Origin, when sent, must match the Host. */
export function sameOriginGuard(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.header('origin');
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      /* invalid origin */
    }
    const expectedHost = req.header('x-forwarded-host') || req.header('host');
    if (host !== expectedHost) {
      res.status(403).json({ error: 'Cross-origin request rejected' });
      return;
    }
  }
  next();
}
