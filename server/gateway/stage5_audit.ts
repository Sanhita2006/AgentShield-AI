import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { StageResult, Verdict } from '../types.ts';
import { canonicalJson, computeEntryHash, constantTimeEqual, sha256Hex, signAuditHmac, verifyAuditHmac } from './crypto.ts';

/** Writes the signed head pointer for the chain's current tail. Call inside the same transaction as the append. */
export function writeAuditHead(db: Database.Database, entryCount: number, lastHash: string, now: number = Date.now()): void {
  const sig = signAuditHmac(`head|${entryCount}|${lastHash}`);
  db.prepare(
    `INSERT INTO audit_head (id, entry_count, last_hash, hmac_sig, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET entry_count = excluded.entry_count, last_hash = excluded.last_hash, hmac_sig = excluded.hmac_sig, updated_at = excluded.updated_at`
  ).run(entryCount, lastHash, sig, now);
}

/** Recomputes the head from whatever is in audit_log (used after bulk seeding). */
export function refreshAuditHead(db: Database.Database, now: number = Date.now()): void {
  const count = (db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
  const last = db.prepare(`SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1`).get() as { entry_hash: string } | undefined;
  if (count === 0 || !last) {
    db.prepare(`DELETE FROM audit_head`).run();
    return;
  }
  writeAuditHead(db, count, last.entry_hash, now);
}

export interface AuditLogRow {
  seq: number;
  id: string;
  timestamp: number;
  request_id: string;
  agent_id: string;
  customer_id: string;
  action: string;
  payload_hash: string;
  decision: string;
  risk_score: number;
  reasons: string;
  stage_results: string;
  prev_hash: string;
  entry_hash: string;
  hmac_sig: string;
}

export function appendAuditEntry(
  db: Database.Database,
  params: {
    requestId: string;
    agentId: string;
    customerId: string;
    action: string;
    payloadHash: string;
    decision: Verdict;
    riskScore: number;
    reasons: string[];
    stageResults: StageResult[];
  },
  now: number = Date.now()
): { auditId: string; entryHash: string; prevHash: string; stageResult: StageResult } {
  const t0 = performance.now();
  const auditId = `aud_${crypto.randomBytes(5).toString('hex')}`;

  const result = db.transaction(() => {
    const lastRow = db.prepare(`SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1`).get() as
      | { entry_hash: string }
      | undefined;
    const prevHash = lastRow?.entry_hash ?? '0'.repeat(64);

    // Build stage 5 result before hashing so stored JSON matches entry_hash byte-for-byte
    const stage5Placeholder: StageResult = {
      stage: 5,
      name: 'Tamper-Evident Audit',
      status: 'PASS',
      latencyMs: Number(Math.max(0.1, performance.now() - t0).toFixed(2)),
      summary: 'Appended to SHA-256 + HMAC hash chain',
      details: { auditId, prevHashPrefix: prevHash.slice(0, 12) },
    };

    const allStages = [...params.stageResults, stage5Placeholder];
    const canonicalPayload = {
      id: auditId,
      timestamp: now,
      requestId: params.requestId,
      agentId: params.agentId,
      customerId: params.customerId,
      action: params.action,
      payloadHash: params.payloadHash,
      decision: params.decision,
      riskScore: params.riskScore,
      reasons: params.reasons,
      stageResults: allStages,
    };

    const entryHash = computeEntryHash(prevHash, canonicalPayload);
    const hmacSig = signAuditHmac(entryHash);

    db.prepare(
      `INSERT INTO audit_log (id, timestamp, request_id, agent_id, customer_id, action, payload_hash, decision, risk_score, reasons, stage_results, prev_hash, entry_hash, hmac_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditId,
      now,
      params.requestId,
      params.agentId,
      params.customerId,
      params.action,
      params.payloadHash,
      params.decision,
      params.riskScore,
      JSON.stringify(params.reasons),
      JSON.stringify(allStages),
      prevHash,
      entryHash,
      hmacSig
    );

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
    writeAuditHead(db, total, entryHash, now);

    return { auditId, entryHash, prevHash, stageResult: stage5Placeholder };
  })();

  return result;
}

/**
 * Records control-plane / lifecycle mutations (approvals, grants, settings, agent status, token suspend/reissue)
 * into the same tamper-evident SHA-256 + HMAC chain so log tampering covers configuration as well as payments.
 */
export function appendLifecycleAudit(
  db: Database.Database,
  params: {
    entityId: string;
    agentId?: string;
    customerId: string;
    action:
      | 'approval_created'
      | 'approval_approved'
      | 'approval_denied'
      | 'approval_expired'
      | 'grant_created'
      | 'grant_revoked'
      | 'grant_edited'
      | 'agent_status_changed'
      | 'settings_updated'
      | 'approval_preferences_updated'
      | 'token_issued'
      | 'token_suspended'
      | 'token_reissued';
    decision?: Verdict;
    riskScore?: number;
    details: Record<string, unknown>;
    summary: string;
  },
  now: number = Date.now()
): { auditId: string; entryHash: string } {
  const { auditId, entryHash } = appendAuditEntry(
    db,
    {
      requestId: params.entityId,
      agentId: params.agentId ?? 'system',
      customerId: params.customerId,
      action: params.action,
      payloadHash: sha256Hex(canonicalJson(params.details)),
      decision: params.decision ?? 'ALLOW',
      riskScore: params.riskScore ?? 0,
      reasons: [params.summary],
      stageResults: [],
    },
    now
  );
  return { auditId, entryHash };
}

export interface ChainVerificationResult {
  valid: boolean;
  totalEntries: number;
  verifiedEntries: number;
  brokenIndex: number | null;
  brokenEntryId: string | null;
  reason: string | null;
  expectedHash?: string;
  actualHash?: string;
  checkedAt: number;
}

export function verifyAuditChain(db: Database.Database): ChainVerificationResult {
  const rows = db.prepare(`SELECT * FROM audit_log ORDER BY seq ASC`).all() as AuditLogRow[];
  let expectedPrevHash = '0'.repeat(64);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        totalEntries: rows.length,
        verifiedEntries: i,
        brokenIndex: i,
        brokenEntryId: row.id,
        reason: `Previous hash link mismatch at entry #${i + 1} (${row.id})`,
        expectedHash: expectedPrevHash,
        actualHash: row.prev_hash,
        checkedAt: Date.now(),
      };
    }

    let parsedReasons: unknown;
    let parsedStages: unknown;
    try {
      parsedReasons = JSON.parse(row.reasons);
      parsedStages = JSON.parse(row.stage_results);
    } catch {
      return {
        valid: false,
        totalEntries: rows.length,
        verifiedEntries: i,
        brokenIndex: i,
        brokenEntryId: row.id,
        reason: `Corrupted JSON payload at entry #${i + 1} (${row.id})`,
        checkedAt: Date.now(),
      };
    }

    const canonicalPayload = {
      id: row.id,
      timestamp: row.timestamp,
      requestId: row.request_id,
      agentId: row.agent_id,
      customerId: row.customer_id,
      action: row.action,
      payloadHash: row.payload_hash,
      decision: row.decision,
      riskScore: row.risk_score,
      reasons: parsedReasons,
      stageResults: parsedStages,
    };

    const recomputedHash = computeEntryHash(row.prev_hash, canonicalPayload);
    if (!constantTimeEqual(recomputedHash, row.entry_hash)) {
      return {
        valid: false,
        totalEntries: rows.length,
        verifiedEntries: i,
        brokenIndex: i,
        brokenEntryId: row.id,
        reason: `Tampered record detected at index ${i} (${row.id}): SHA-256 digest does not match stored entry_hash`,
        expectedHash: recomputedHash,
        actualHash: row.entry_hash,
        checkedAt: Date.now(),
      };
    }

    if (!verifyAuditHmac(recomputedHash, row.hmac_sig)) {
      return {
        valid: false,
        totalEntries: rows.length,
        verifiedEntries: i,
        brokenIndex: i,
        brokenEntryId: row.id,
        reason: `HMAC signature verification failed at index ${i} (${row.id})`,
        expectedHash: signAuditHmac(recomputedHash),
        actualHash: row.hmac_sig,
        checkedAt: Date.now(),
      };
    }

    expectedPrevHash = row.entry_hash;
  }

  // Tail-truncation / rollback check: the chain links only look backwards, so deleting the newest
  // entries leaves a perfectly consistent (shorter) chain. The signed head catches that.
  const head = db.prepare(`SELECT entry_count, last_hash, hmac_sig FROM audit_head WHERE id = 1`).get() as
    | { entry_count: number; last_hash: string; hmac_sig: string }
    | undefined;
  if (head) {
    const headSigOk = verifyAuditHmac(`head|${head.entry_count}|${head.last_hash}`, head.hmac_sig);
    if (!headSigOk || head.entry_count !== rows.length || !constantTimeEqual(head.last_hash, expectedPrevHash)) {
      return {
        valid: false,
        totalEntries: rows.length,
        verifiedEntries: rows.length,
        brokenIndex: Math.max(0, Math.min(rows.length, head.entry_count) - 1),
        brokenEntryId: rows.length ? rows[rows.length - 1].id : null,
        reason: headSigOk
          ? `Audit log was truncated or rolled back: signed head records ${head.entry_count} entries, found ${rows.length}`
          : 'Audit head pointer signature is invalid',
        expectedHash: head.last_hash,
        actualHash: expectedPrevHash,
        checkedAt: Date.now(),
      };
    }
  } else if (rows.length > 0) {
    return {
      valid: false,
      totalEntries: rows.length,
      verifiedEntries: rows.length,
      brokenIndex: null,
      brokenEntryId: null,
      reason: 'Audit head pointer is missing (it may have been deleted to hide truncation)',
      checkedAt: Date.now(),
    };
  }

  return {
    valid: true,
    totalEntries: rows.length,
    verifiedEntries: rows.length,
    brokenIndex: null,
    brokenEntryId: null,
    reason: null,
    checkedAt: Date.now(),
  };
}

export interface ExternalAuditAnchor {
  version: 1;
  exportedAt: number;
  entryCount: number;
  firstSeq: number;
  lastSeq: number;
  lastEntryId: string;
  lastHash: string;
  hmacSig: string;
  anchorDigest: string;
}

/**
 * Exports a signed snapshot of the current audit head so operators can store it outside SQLite
 * (git commit, syslog, printed/emailed compliance receipt). If a DB+HMAC attacker rewrites or truncates
 * the table and forges a new audit_head, comparing against the external anchor catches it.
 */
export function exportAuditAnchor(db: Database.Database, now: number = Date.now()): ExternalAuditAnchor {
  const chain = verifyAuditChain(db);
  if (!chain.valid) {
    throw new Error(`Refusing to anchor corrupted audit chain: ${chain.reason}`);
  }
  const rows = db.prepare(`SELECT seq, id, entry_hash FROM audit_log ORDER BY seq ASC`).all() as Array<{
    seq: number;
    id: string;
    entry_hash: string;
  }>;
  if (rows.length === 0) {
    throw new Error('Cannot export anchor from an empty audit log');
  }
  const firstSeq = rows[0].seq;
  const last = rows[rows.length - 1];
  const entryCount = rows.length;
  const hmacSig = signAuditHmac(`anchor|1|${entryCount}|${last.seq}|${last.id}|${last.entry_hash}|${now}`);
  const anchorDigest = sha256Hex(
    canonicalJson({ version: 1, exportedAt: now, entryCount, firstSeq, lastSeq: last.seq, lastEntryId: last.id, lastHash: last.entry_hash })
  );
  return {
    version: 1,
    exportedAt: now,
    entryCount,
    firstSeq,
    lastSeq: last.seq,
    lastEntryId: last.id,
    lastHash: last.entry_hash,
    hmacSig,
    anchorDigest,
  };
}

export interface AnchorVerificationResult {
  valid: boolean;
  reason: string | null;
  chainValid: boolean;
  anchorSignatureValid: boolean;
  currentEntryCount: number;
  anchoredEntryCount: number;
}

export function verifyAuditAgainstAnchor(db: Database.Database, anchor: ExternalAuditAnchor): AnchorVerificationResult {
  const sigMessage = `anchor|1|${anchor.entryCount}|${anchor.lastSeq}|${anchor.lastEntryId}|${anchor.lastHash}|${anchor.exportedAt}`;
  const anchorSignatureValid = Boolean(anchor.hmacSig && verifyAuditHmac(sigMessage, anchor.hmacSig));
  if (!anchorSignatureValid) {
    return {
      valid: false,
      reason: 'External anchor HMAC signature is invalid',
      chainValid: false,
      anchorSignatureValid: false,
      currentEntryCount: 0,
      anchoredEntryCount: anchor.entryCount,
    };
  }

  const chain = verifyAuditChain(db);
  if (!chain.valid) {
    return {
      valid: false,
      reason: chain.reason,
      chainValid: false,
      anchorSignatureValid: true,
      currentEntryCount: chain.totalEntries,
      anchoredEntryCount: anchor.entryCount,
    };
  }

  if (chain.totalEntries < anchor.entryCount) {
    return {
      valid: false,
      reason: `History truncated or rewritten: DB has ${chain.totalEntries} entries but external anchor recorded ${anchor.entryCount}`,
      chainValid: true,
      anchorSignatureValid: true,
      currentEntryCount: chain.totalEntries,
      anchoredEntryCount: anchor.entryCount,
    };
  }

  const rows = db.prepare(`SELECT id, seq, entry_hash FROM audit_log ORDER BY seq ASC`).all() as Array<{
    id: string;
    seq: number;
    entry_hash: string;
  }>;
  const anchoredRow = rows[anchor.entryCount - 1];
  if (
    !anchoredRow ||
    anchoredRow.id !== anchor.lastEntryId ||
    anchoredRow.seq !== anchor.lastSeq ||
    !constantTimeEqual(anchoredRow.entry_hash, anchor.lastHash)
  ) {
    return {
      valid: false,
      reason: `History rewrite detected at entry #${anchor.entryCount}: stored hash/id does not match externally anchored snapshot`,
      chainValid: true,
      anchorSignatureValid: true,
      currentEntryCount: chain.totalEntries,
      anchoredEntryCount: anchor.entryCount,
    };
  }

  return {
    valid: true,
    reason: null,
    chainValid: true,
    anchorSignatureValid: true,
    currentEntryCount: chain.totalEntries,
    anchoredEntryCount: anchor.entryCount,
  };
}

export function simulateAuditTampering(db: Database.Database): { tamperedEntryId: string; tamperedIndex: number } {
  const rows = db.prepare(`SELECT * FROM audit_log ORDER BY seq ASC`).all() as AuditLogRow[];
  if (rows.length === 0) {
    throw new Error('No audit entries available to tamper');
  }
  const targetIndex = rows.length > 1 ? Math.floor(rows.length / 2) : 0;
  const target = rows[targetIndex];
  const tamperedReasons = JSON.stringify(['TAMPERED BY ROGUE INSIDER: risk_score altered to 0']);
  db.prepare(`UPDATE audit_log SET risk_score = 0, decision = 'ALLOW', reasons = ? WHERE id = ?`).run(
    tamperedReasons,
    target.id
  );
  return { tamperedEntryId: target.id, tamperedIndex: targetIndex };
}
