import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { UNATTRIBUTED_CUSTOMER, type GatewayExecuteRequest, type StageResult } from '../types.ts';
import { computeFingerprintHash, constantTimeEqual, verifyDelegationToken } from './crypto.ts';
import { appendLifecycleAudit } from './stage5_audit.ts';

export interface Stage1Output {
  passed: boolean;
  hardBlock: boolean;
  agentId: string;
  customerId: string;
  grantId: string;
  jti: string;
  customerReason?: string;
  technicalReason?: string;
  threatType?: string;
  stageResult: StageResult;
}

const ALERT_WINDOW_MS = 5 * 60_000;
const MAX_STOLEN_TOKEN_ALERTS_PER_AGENT = 2;

export async function runStage1Identity(
  db: Database.Database,
  req: GatewayExecuteRequest,
  now: number = Date.now()
): Promise<Stage1Output> {
  const t0 = performance.now();

  const fail = (
    customerReason: string,
    technicalReason: string,
    threatType: string,
    agentId = 'unknown',
    customerId = UNATTRIBUTED_CUSTOMER,
    grantId = 'unknown',
    jti = 'unknown',
    extra: Record<string, unknown> = {}
  ): Stage1Output => ({
    passed: false,
    hardBlock: true,
    agentId,
    customerId,
    grantId,
    jti,
    customerReason,
    technicalReason,
    threatType,
    stageResult: {
      stage: 1,
      name: 'Identity & Token Binding',
      status: 'FAIL',
      latencyMs: Number((performance.now() - t0).toFixed(2)),
      summary: technicalReason,
      details: { threatType, ...extra },
    },
  });

  // 1. Verify JWT signature and expiration
  let claims;
  try {
    claims = await verifyDelegationToken(req.token);
  } catch (err) {
    return fail(
      'The agent presented an invalid or expired authorization token.',
      `JWT verification failed: ${err instanceof Error ? err.message : 'invalid signature/exp'}`,
      'invalid_token'
    );
  }

  const { agent_id: agentId, customer_id: customerId, grant_id: grantId, jti, fp_hash: tokenFpHash } = claims;

  // 2. Check registered agent status
  const agent = db.prepare(`SELECT id, name, status FROM agents WHERE id = ?`).get(agentId) as
    | { id: string; name: string; status: string }
    | undefined;
  if (!agent) {
    return fail(
      'An unregistered AI agent attempted to access your account.',
      `Unknown agent_id: ${agentId}`,
      'unknown_agent',
      agentId,
      customerId,
      grantId,
      jti
    );
  }

  if (agent.status !== 'active') {
    return fail(
      `${agent.name} is currently ${agent.status} by bank security controls.`,
      `Agent ${agentId} status is '${agent.status}' (requires 'active')`,
      'agent_suspended',
      agentId,
      customerId,
      grantId,
      jti
    );
  }

  // 3. Check token record in database (jti revocation / suspension / compromised check)
  const tokenRow = db.prepare(`SELECT * FROM tokens WHERE jti = ?`).get(jti) as
    | { jti: string; status: string; fingerprint_hash: string; expires_at: number; revoked_at: number | null }
    | undefined;

  if (!tokenRow) {
    return fail(
      'This agent token is not recognized by the gateway.',
      `Token jti ${jti} missing from active token registry`,
      'unregistered_token',
      agentId,
      customerId,
      grantId,
      jti
    );
  }

  if (tokenRow.status === 'compromised') {
    return fail(
      'This agent token was previously flagged as compromised and revoked.',
      `Token jti ${jti} is marked 'compromised'`,
      'stolen_token',
      agentId,
      customerId,
      grantId,
      jti
    );
  }

  if (tokenRow.status === 'suspended') {
    return fail(
      `This ${agent.name} token is suspended after a device mismatch and must be explicitly re-issued by you.`,
      `Token jti ${jti} is in 'suspended' state pending explicit customer re-issue`,
      'stolen_token',
      agentId,
      customerId,
      grantId,
      jti,
      { tokenSuspended: true, requiresReissue: true }
    );
  }

  if (tokenRow.status === 'revoked') {
    const msSinceRevoke = tokenRow.revoked_at ? Math.max(1, now - tokenRow.revoked_at) : undefined;
    return fail(
      'Access for this agent was revoked by you.',
      `Token jti ${jti} is revoked${msSinceRevoke !== undefined ? ` (${msSinceRevoke}ms ago)` : ''}`,
      'revoked_token',
      agentId,
      customerId,
      grantId,
      jti,
      { revokedAgoMs: msSinceRevoke }
    );
  }

  if (tokenRow.expires_at < now) {
    return fail(
      'The agent session token expired.',
      `Token jti ${jti} expired at ${new Date(tokenRow.expires_at).toISOString()}`,
      'expired_token',
      agentId,
      customerId,
      grantId,
      jti
    );
  }

  // 4. Device / Client Fingerprint Binding Check (Stolen token defense without griefing-burn)
  const presentedFpHash = computeFingerprintHash(req.fingerprint);
  if (!constantTimeEqual(presentedFpHash, tokenFpHash) || !constantTimeEqual(presentedFpHash, tokenRow.fingerprint_hash)) {
    // Move token into 'suspended' state (requiring explicit re-issue by customer) instead of
    // permanently burning the entire grant/session, and rate-limit alerts per agent to prevent alert flooding.
    db.prepare(`UPDATE tokens SET status = 'suspended', revoked_at = ? WHERE jti = ?`).run(now, jti);

    const recentAlerts = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM alerts WHERE customer_id = ? AND agent_id = ? AND threat_type = 'stolen_token' AND created_at >= ?`
        )
        .get(customerId, agentId, now - ALERT_WINDOW_MS) as { cnt: number }
    ).cnt;

    let alertRateLimited = false;
    if (recentAlerts < MAX_STOLEN_TOKEN_ALERTS_PER_AGENT) {
      db.prepare(
        `INSERT INTO alerts (id, customer_id, agent_id, severity, threat_type, title, message, acknowledged, created_at) VALUES (?, ?, ?, 'critical', 'stolen_token', ?, ?, 0, ?)`
      ).run(
        `alert_${crypto.randomBytes(4).toString('hex')}`,
        customerId,
        agentId,
        'Stolen Agent Token Intercepted & Suspended',
        `${agent.name} token (${jti.slice(0, 10)}) was presented from an unrecognized device fingerprint (${req.fingerprint.ip} / ${req.fingerprint.asn}). Token suspended; explicit customer re-issue required.`,
        now
      );
    } else {
      alertRateLimited = true;
    }

    appendLifecycleAudit(
      db,
      {
        entityId: jti,
        agentId,
        customerId,
        action: 'token_suspended',
        decision: 'BLOCK',
        riskScore: 98,
        details: {
          jti,
          grantId,
          expectedFpPrefix: tokenFpHash.slice(0, 16),
          actualFpPrefix: presentedFpHash.slice(0, 16),
          ip: req.fingerprint.ip,
          asn: req.fingerprint.asn,
          alertRateLimited,
        },
        summary: `Token ${jti.slice(0, 10)} suspended due to device fingerprint mismatch (${req.fingerprint.ip})`,
      },
      now
    );

    return fail(
      `Blocked! Someone tried to use ${agent.name}'s authorization token from an unrecognized device (${req.fingerprint.ip}). The token is now suspended and requires your re-issue.`,
      `Device fingerprint mismatch on jti=${jti}. Expected ${tokenFpHash.slice(0, 12)}..., got ${presentedFpHash.slice(0, 12)}... (IP=${req.fingerprint.ip}, Runtime=${req.fingerprint.agentRuntimeId}). Token flagged suspended pending re-issue.`,
      'stolen_token',
      agentId,
      customerId,
      grantId,
      jti,
      {
        tokenSuspended: true,
        requiresReissue: true,
        alertRateLimited,
        expectedFp: tokenFpHash.slice(0, 16),
        actualFp: presentedFpHash.slice(0, 16),
      }
    );
  }

  // 5. Replay protection: 60s timestamp window + unique nonce
  const ageMs = Math.abs(now - req.timestamp);
  if (!Number.isFinite(req.timestamp) || ageMs > 60_000) {
    return fail(
      'Request rejected because its security timestamp is stale (possible replay attack).',
      `Replay protection failed: request timestamp drift ${Math.round(ageMs / 1000)}s exceeds 60s window`,
      'replay_attack',
      agentId,
      customerId,
      grantId,
      jti,
      { driftMs: ageMs }
    );
  }

  if (!req.nonce || req.nonce.length < 8) {
    return fail(
      'Agent request lacked a valid cryptographic nonce.',
      'Missing or malformed request nonce',
      'replay_attack',
      agentId,
      customerId,
      grantId,
      jti
    );
  }

  const existingNonce = db.prepare(`SELECT nonce FROM used_nonces WHERE nonce = ?`).get(req.nonce);
  if (existingNonce) {
    return fail(
      'Blocked a duplicate request replay attempt.',
      `Replay detected: nonce '${req.nonce}' was already consumed`,
      'replay_attack',
      agentId,
      customerId,
      grantId,
      jti,
      { replayedNonce: req.nonce }
    );
  }

  db.prepare(`INSERT INTO used_nonces (nonce, agent_id, used_at) VALUES (?, ?, ?)`).run(req.nonce, agentId, now);
  // Nonces older than the 60s replay window can never be replayed again; keep the table small
  db.prepare(`DELETE FROM used_nonces WHERE used_at < ?`).run(now - 5 * 60_000);

  return {
    passed: true,
    hardBlock: false,
    agentId,
    customerId,
    grantId,
    jti,
    stageResult: {
      stage: 1,
      name: 'Identity & Token Binding',
      status: 'PASS',
      latencyMs: Number((performance.now() - t0).toFixed(2)),
      summary: `Verified ${agent.name} JWT, fingerprint binding & fresh nonce`,
      details: { agentId, jti, fingerprintMatch: true, timestampSkewMs: ageMs },
    },
  };
}
