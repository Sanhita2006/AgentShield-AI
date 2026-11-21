/**
 * Central runtime configuration.
 *
 * - In production (NODE_ENV=production) every secret MUST be provided via the
 *   environment; the server refuses to start with dev defaults.
 * - DEMO_MODE (default: on outside production) enables the hackathon conveniences:
 *   a preview customer session for signed-out visitors, role switching, demo reset,
 *   audit tamper simulation and client-declared agent fingerprints.
 */
export function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return !isProd();
}

const DEV_DEFAULTS = {
  AGENTSHIELD_JWT_SECRET: 'dev-only-jwt-secret-not-for-production',
  AGENTSHIELD_AUDIT_HMAC_KEY: 'dev-only-audit-hmac-key-not-for-production',
  BANK_INTERNAL_SECRET: 'dev-only-bank-internal-secret-not-for-production',
  SESSION_SECRET: 'dev-only-session-secret-not-for-production',
} as const;

export type SecretName = keyof typeof DEV_DEFAULTS;

export function getSecret(name: SecretName): string {
  const v = process.env[name];
  if (v && v.length >= 24) return v;
  if (isProd()) {
    throw new Error(`${name} must be set (min 24 chars) when NODE_ENV=production`);
  }
  return DEV_DEFAULTS[name];
}

/** Call once at startup. Throws in production if any secret is missing, short, or reused. */
export function assertConfig(): void {
  const names = Object.keys(DEV_DEFAULTS) as SecretName[];
  const values = names.map((n) => getSecret(n));
  if (isProd()) {
    if (new Set(values).size !== values.length) {
      throw new Error('Each AgentShield secret must be unique (JWT, audit HMAC, bank internal, session)');
    }
    if (isDemoMode()) {
      console.warn('[agentshield] WARNING: DEMO_MODE=true in production. Demo shortcuts are enabled.');
    }
  } else {
    console.warn('[agentshield] Running with development secrets. Set real secrets before deploying.');
  }
}

/** When true the gateway trusts the fingerprint IP sent by the agent; otherwise it uses the socket IP. */
export function trustClientFingerprint(): boolean {
  const v = process.env.TRUST_CLIENT_FINGERPRINT;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return isDemoMode();
}
