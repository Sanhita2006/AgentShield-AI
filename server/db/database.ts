import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { refreshAuditHead } from '../gateway/stage5_audit.ts';

let dbInstance: Database.Database | null = null;

export function getDb(customPath?: string): Database.Database {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const dbPath =
    customPath ??
    process.env.AGENTSHIELD_DB_PATH ??
    path.resolve(process.cwd(), 'data', 'agentshield.db');

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);

  if (!customPath) {
    dbInstance = db;
  }
  return db;
}

export function setDbForTest(db: Database.Database): void {
  dbInstance = db;
}

export function initSchema(db: Database.Database): void {
  const hadAuditHead = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_head'`).get());
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('customer', 'bank_admin')),
      customer_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      city TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      pin_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      account_type TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      balance INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS payees (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      vpa TEXT NOT NULL,
      category TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      agent_id TEXT,
      payee_id TEXT,
      payee_name TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      publisher TEXT NOT NULL,
      description TEXT NOT NULL,
      public_key TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'quarantined')),
      risk_tier TEXT NOT NULL DEFAULT 'standard',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      allowed_actions TEXT NOT NULL,
      allowed_categories TEXT NOT NULL,
      payee_allowlist TEXT NOT NULL,
      per_txn_limit INTEGER NOT NULL,
      daily_limit INTEGER NOT NULL,
      monthly_limit INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      allowed_hours TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS tokens (
      jti TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked', 'compromised')),
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (grant_id) REFERENCES grants(id)
    );

    CREATE TABLE IF NOT EXISTS used_nonces (
      nonce TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      used_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS baselines (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      typical_amount_mean INTEGER NOT NULL DEFAULT 150000,
      typical_amount_std INTEGER NOT NULL DEFAULT 50000,
      typical_hours TEXT NOT NULL,
      known_payees TEXT NOT NULL,
      typical_action_mix TEXT NOT NULL,
      typical_call_rate_per_min REAL NOT NULL DEFAULT 2,
      last_action_type TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE (agent_id, customer_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      stated_intent TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      grant_id TEXT,
      session_id TEXT,
      action TEXT NOT NULL,
      category TEXT,
      payee_id TEXT,
      payee_name TEXT,
      amount INTEGER DEFAULT 0,
      stated_intent TEXT,
      provenance TEXT NOT NULL,
      context_snippet TEXT,
      idempotency_key TEXT,
      payload_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('ALLOW', 'ASK_CUSTOMER', 'BLOCK')),
      risk_score INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      technical_reasons TEXT NOT NULL,
      signals TEXT NOT NULL,
      stage_results TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      hard_block INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      reasons TEXT NOT NULL,
      risk_score INTEGER NOT NULL,
      action_payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
      is_hazardous INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      timestamp INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      decision TEXT NOT NULL,
      risk_score INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      stage_results TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      hmac_sig TEXT NOT NULL
    );

    -- Signed pointer to the newest audit entry. The chain alone can't reveal that its last N entries
    -- were deleted; this row (HMAC-signed with the audit key) can.
    CREATE TABLE IF NOT EXISTS audit_head (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      entry_count INTEGER NOT NULL,
      last_hash TEXT NOT NULL,
      hmac_sig TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      agent_id TEXT,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
      threat_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Migrate pre-existing approvals tables that predate is_hazardous
  const hasHazardousCol = db.prepare(`SELECT 1 FROM pragma_table_info('approvals') WHERE name = 'is_hazardous'`).get();
  if (!hasHazardousCol) {
    db.exec(`ALTER TABLE approvals ADD COLUMN is_hazardous INTEGER NOT NULL DEFAULT 0`);
  }

  // Migrate pre-existing customers tables that predate timezone
  const hasTimezoneCol = db.prepare(`SELECT 1 FROM pragma_table_info('customers') WHERE name = 'timezone'`).get();
  if (!hasTimezoneCol) {
    db.exec(`ALTER TABLE customers ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'`);
  }

  // Migrate pre-existing tokens tables whose CHECK constraint lacked 'suspended'
  const tokenSqlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tokens'`).get() as
    | { sql: string }
    | undefined;
  if (tokenSqlRow?.sql && !tokenSqlRow.sql.includes("'suspended'")) {
    const hasTokRevokedAt = Boolean(
      db.prepare(`SELECT 1 FROM pragma_table_info('tokens') WHERE name = 'revoked_at'`).get()
    );
    const revokedCol = hasTokRevokedAt ? 'revoked_at' : 'NULL';
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tokens_migrated (
          jti TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          customer_id TEXT NOT NULL,
          grant_id TEXT NOT NULL,
          fingerprint_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked', 'compromised')),
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          FOREIGN KEY (agent_id) REFERENCES agents(id),
          FOREIGN KEY (customer_id) REFERENCES customers(id),
          FOREIGN KEY (grant_id) REFERENCES grants(id)
        );
        INSERT INTO tokens_migrated (jti, agent_id, customer_id, grant_id, fingerprint_hash, status, issued_at, expires_at, revoked_at)
        SELECT jti, agent_id, customer_id, grant_id, fingerprint_hash, status, issued_at, expires_at, ${revokedCol} FROM tokens;
        DROP TABLE tokens;
        ALTER TABLE tokens_migrated RENAME TO tokens;
      `);
    })();
    db.pragma('foreign_keys = ON');
  }

  // One-time monetary migration for legacy pre-paise databases: convert REAL rupees -> INTEGER paise.
  const hasCustomers = (db.prepare(`SELECT COUNT(*) AS cnt FROM customers`).get() as { cnt: number }).cnt > 0;
  const moneyUnitRow = db.prepare(`SELECT value FROM settings WHERE key = 'money_unit'`).get() as { value: string } | undefined;
  if (hasCustomers && moneyUnitRow?.value !== 'paise') {
    const now = Date.now();
    db.transaction(() => {
      db.exec(`
        UPDATE accounts SET balance = CAST(ROUND(balance * 100) AS INTEGER);
        UPDATE transactions SET amount = CAST(ROUND(amount * 100) AS INTEGER);
        UPDATE grants SET
          per_txn_limit = CAST(ROUND(per_txn_limit * 100) AS INTEGER),
          daily_limit = CAST(ROUND(daily_limit * 100) AS INTEGER),
          monthly_limit = CAST(ROUND(monthly_limit * 100) AS INTEGER);
        UPDATE baselines SET
          typical_amount_mean = CAST(ROUND(typical_amount_mean * 100) AS INTEGER),
          typical_amount_std = CAST(ROUND(typical_amount_std * 100) AS INTEGER);
        UPDATE requests SET amount = CAST(ROUND(COALESCE(amount, 0) * 100) AS INTEGER);
      `);
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('money_unit', 'paise', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(now);
    })();
  }

  // One-time migration for databases created before audit_head existed: anchor the current tail.
  if (!hadAuditHead && db.prepare(`SELECT 1 FROM audit_log LIMIT 1`).get()) {
    refreshAuditHead(db);
  }
}
