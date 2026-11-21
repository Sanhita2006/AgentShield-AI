# AgentShield Threat Model & Future Work

## 1. Security Boundaries

```
[Untrusted / Compromised AI Agent]
        |  (Bound JWT + Nonce + Provenance + Stated Intent)
        v
[AgentShield 5-Stage Gateway]  <--->  [Customer App (SSE + PIN)]
        |  (x-bank-internal-secret + x-bank-authorization 30s HMAC)
        v
[Core Bank Ledger (/api/bank/*)]
```

Agents **never** possess banking session cookies, the bank internal secret (`BANK_INTERNAL_SECRET`), or the gateway execution signing key (`AGENTSHIELD_BANK_AUTH_KEY` / derived JWT subkey). Every request into `/api/bank/execute` validates both `x-bank-internal-secret` (constant-time) and a short-lived signed `x-bank-authorization` token bound to the exact `{requestId, customerId, agentId, action, amountPaise, payeeId, idempotencyKey}`.

---

## 2. Threat Matrix

| Threat / Attack Vector | Target Layer | Stopping Stage | Concrete Enforcement Mechanism |
|---|---|---|---|
| **Stolen Bearer / Delegation JWT** | Identity | Stage 1 | JWT `jti` bound to `SHA256(agentRuntimeId \| ip \| asn \| userAgent)`. Replay from foreign runtime/IP fails hash check, puts the token in `suspended` state (preventing token-burn griefing while blocking abuse until explicit customer re-issue), and raises a rate-limited alert. |
| **HTTP Request Replay** | Identity | Stage 1 | Enforces `±60s` timestamp skew window and unique `nonce` stored in `used_nonces`. |
| **Over-Permissioned Read-Only Agent** | Authorization | Stage 2 | Default-deny grant engine checks `action` against `allowed_actions`, `category` against `allowed_categories`, and optional `payee_allowlist`. |
| **Limit Circumvention / Draining** | Authorization | Stage 2 | Exact integer-paise per-txn cap + cumulative 24h (`daily_limit`) and 30d (`monthly_limit`) sums computed live from SQLite `transactions`. |
| **Delayed Revocation Race** | Authorization | Stage 2 | Revoking sets `grants.status = 'revoked'` and marks associated JWTs `revoked` synchronously inside SQLite; next call is blocked in `<5ms`. |
| **Indirect Prompt Injection (PDF/Web)** | Behaviour | Stage 3 | Flags money-moving actions originating from `tool_output`, `untrusted_document`, or `web_content` + regex/heuristic detector extracting matched attack snippets (`ignore previous instructions`, hidden transfers, override commands). |
| **Stated Intent Mismatch** | Behaviour | Stage 3 | Compares declared session task (`"check balance"` or `"pay electricity bill"`) against actual tool call (`transfer` / new payee). |
| **Structuring / Smurfing (₹4,999 x2)** | Behaviour | Stage 3 | Detects clustering at `92%–100%` of `per_txn_limit` and sliding-window velocity bursts using integer paise math. |
| **Anomalous 3 AM New Payee** | Behaviour & HITL | Stage 3 & 4 | Evaluates off-hours in the customer's stored IANA timezone (default `Asia/Kolkata`, not server-local time), combines amount z-score and unseen payee into `ASK_CUSTOMER`, and escalates over SSE with server-enforced PIN (`2026` in demo seed) + idempotent single execution. |
| **Baseline Poisoning** | Behaviour | Stage 3 | Rolling `baselines` table updates **strictly** from `ALLOW` or customer-approved requests; blocked/denied traffic never shifts normal stats. |
| **Direct Core Bank Bypass / Forged Amount** | Perimeter | Bank API | `/api/bank/execute` rejects requests lacking valid `x-bank-internal-secret` OR lacking a valid 30s signed `x-bank-authorization` bound to amount in paise, payee, customer, agent, and idempotency key, plus enforces an independent `BANK_MAX_TXN_RUPEES` ceiling. |
| **Post-Incident Log Tampering / Truncation** | Forensics | Stage 5 | Every gateway decision and security lifecycle event (approvals, grants, settings, agent status, token suspend/re-issue) appends canonical SHA-256 `entry_hash = H(prev_hash \| canonical_payload)` + `HMAC-SHA256`, verified via `/api/audit/verify` and exportable to external anchors (`/api/audit/anchor` / `npm run audit:anchor`). |

---

### 2b. Web-layer & Persistence Controls

| Threat | Control |
|---|---|
| Approving a payment without the PIN, or approving someone else's | PIN enforced server-side on every approve; approvals bound to the owning customer; 5 wrong PINs lock approve |
| Minting or re-issuing tokens for any grant | `/gateway/tokens` and `/gateway/tokens/:jti/reissue` require a customer session and that customer's own active grant |
| Forging the agent's address | Outside demo mode the gateway uses the connection IP, not the one in the request body |
| Alert flooding via token-burn DoS | Fingerprint mismatch suspends instead of burning permanently and rate-limits `stolen_token` alerts per agent (max 2 / 5 min) |
| Floating-point rounding drift (`0.1 + 0.2`) | All ledger balances, grant caps, limits, baselines, and requests are stored and summed as exact integer paise (`100` paise = ₹1) |
| Privilege escalation to admin | No implicit session in production; role switch exists only in demo mode; console routes require admin |
| CSRF | SameSite=Strict cookie plus Origin check on state-changing requests |
| Weak or default secrets | Production start-up fails without four distinct secrets of 24+ characters |
| Credential theft from the database | Passwords and PINs stored as salted scrypt hashes |
| Cross-customer data in live events | Events carrying a customer id are delivered only to that customer and admins |
| Approving a stale request after a grant was revoked / agent suspended | Approval re-runs Stage 2 at settlement time; a failing re-check cancels the request (HTTP 409). Settlement and status change commit in one DB transaction |
| Agent bearer token leaking via the approvals table, API or SSE | Token is redacted before the request is stored; `action_payload` is never sent to browsers |
| Category laundering (declaring `electricity` for a `general` payee) | The customer's stored payee category is authoritative; a contradicting claim is a hard block |
| Dodging a strict payee allowlist by omitting `payeeId` | Allowlisted grants require an allow-listed `payeeId` on every payment |
| Cross-tenant idempotency-key probing | A key already used by another customer/agent is rejected, never replayed; payee lookups are scoped to the customer |
| Brand-new agent skipping behavioural checks | No baseline on a money-moving request is itself a risk signal that forces customer approval |
| Agent adding a payee unattended | `add_payee` always escalates to the customer |
| Spoofing the hour via `simulatedHour` | Honoured only in DEMO_MODE; production evaluates wall-clock time in customer timezone (`Asia/Kolkata`) |
| Junk requests polluting a real customer's audit trail | Pre-authentication failures are attributed to `unattributed`, never to a real customer |
| Audit tail truncation or dual DB+HMAC rewrite | HMAC-signed `audit_head` catches tail truncation automatically; **Honest Limitation**: an attacker with simultaneous write access to SQLite and `AGENTSHIELD_AUDIT_HMAC_KEY` can rewrite the entire chain and `audit_head` unless the head hash is exported and pinned to an external anchor (`/api/audit/anchor` or `npm run audit:anchor`). |
| Stale / revoked sessions, PIN brute-force across approvals | Session cookie is re-checked against `users` on every request (12 h TTL); per-customer PIN lockout (10 failures / 15 min) on top of the per-approval limit |

## 3. Limitations & Future Work

**Remaining open items (tracked for upcoming phases):**
1. **Proof-of-possession for agent tokens (Phase 3)**: Bind each token to an agent-held Ed25519 key (`cnf` JWK thumbprint + signed requests) so a stolen token is useless even from the same IP/network.
2. **Transaction-bound approval hashes & auto-quarantine (Phase 3)**: Cryptographically hash pending approval terms and automatically quarantine agents after repeated blocks.
3. **Self-reported agent fields & semantic LLM judge (Phase 2)**: Agent-declared fields (`intent`, `provenance`, `contextSnippet`) remain self-reported unless corroborated by a registered `session/start` event from the customer app or a hardened schema-validated Stage 3b LLM judge.
4. **Regex injection limits & benchmark evaluation (Phase 2)**: Replace the fixed scenario badge alone with a ≥250-sample labeled adversarial & benign benchmark reporting misses honestly alongside obfuscation/multilingual normalization.
5. **Process-local throttles (Phase 3)**: Move login/PIN throttles and rate limiters from in-memory maps to SQLite-backed storage for single-node durability across restarts (multi-node requires Redis).
6. **Production Core Banking & NPCI / RBI Alignment (Phase 4)**: Map grants onto **RBI Account Aggregator** consent artefacts and **NPCI UPI Reserve Pay / UPI Circle** mandates; live deployment requires mTLS and HSM-backed keys.


## Benchmark interpretation (read before quoting numbers)

- The main benchmark (`docs/BENCHMARK.md`, 96.3% attack stop rate, 0% benign false positives) is **largely template-generated** by loops over fixed phrasings and payees. It measures the detector against its authors' own patterns and is not an independent estimate. Any held-out or hand-written set should be quoted alongside it and will be lower.
- "Contained by Stage 2" means **loss <= grant cap**, and the per-sample flag is set by the benchmark author, not measured. Real worst-case exposure comes from the grant itself: the seeded BillPay grant allows up to **₹5,000 per transaction, ₹10,000 per day, ₹25,000 per month** to any payee in its allowed categories (its payee allowlist is empty), during its allowed hours. A paraphrased injection that passes Stage 3 can therefore move up to ₹25,000 per month in the worst case. Tightening this (non-empty allowlist, smaller caps) is a grant-configuration decision.
- Any number from the mock LLM judge is **SIMULATED**, not a live-model measurement.
