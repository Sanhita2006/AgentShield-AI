# AgentShield — Zero-Trust Security Gateway for AI Banking Agents

**Team Strive GBI** · Sushweta Ghosh, Sanhita Bhattacharjee, Indrani Deb Roy

AgentShield is a zero-trust policy enforcement, behavioural anomaly detection, human-in-the-loop escalation, and tamper-evident audit gateway sitting cleanly between AI agents and core banking APIs:

```
AI Agent  --->  AgentShield Gateway (/api/gateway/*)  --->  Mock Bank API (/api/bank/*)
```

Core banking endpoints trust **only** requests originating from AgentShield carrying the constant-time verified internal header (`x-bank-internal-secret`). Agents can never bypass the gateway.

---

## Quick Start (One-Command Local Run)

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

To run the full automated pipeline test suite:

```bash
npm test
```

### Production Build & Docker

```bash
npm run build
NODE_ENV=production npm start
```

Or with Docker (**Docker: untested** - the Dockerfile was written without a Docker daemon available; it uses `node:22-slim`):

```bash
docker build -t agentshield .
docker run -p 3000:3000 \
  -e AGENTSHIELD_JWT_SECRET=<24+ chars> -e AGENTSHIELD_AUDIT_HMAC_KEY=<24+ chars, different> \
  -e BANK_INTERNAL_SECRET=<24+ chars, different> -e SESSION_SECRET=<24+ chars, different> \
  agentshield
```

#### Node version (important on Windows)

Use **Node 22 LTS** (`.nvmrc` and `engines` are pinned to `>=22 <23`, enforced by `.npmrc` `engine-strict=true`). `better-sqlite3` is a native module; on Node 24 a Windows install without Visual Studio Build Tools was reported to fall back to `node-gyp rebuild` and fail. This is **not verified from this sandbox** (no network, no Windows). Verify on your machine:

```powershell
nvm install 22; nvm use 22
node -v ; Remove-Item -Recurse -Force node_modules ; npm ci
node -e "require('better-sqlite3')(':memory:'); console.log('sqlite OK')"
```

Last resort if a source build is unavoidable: install Visual Studio Build Tools ("Desktop development with C++") plus Python, then `npm rebuild better-sqlite3 --build-from-source`.

#### Self-test

Simplest: `npm run selftest` (runs against an in-memory DB, no server needed). Over HTTP, `/api/selftest` is open only in demo mode; with `NODE_ENV=production` / `DEMO_MODE=false` it requires a `bank_admin` session, so a plain `curl http://localhost:3000/api/selftest` returns 401/403. Authenticated example:

```bash
curl -c jar.txt -H "Content-Type: application/json" \
  -d '{"email":"admin@agentshield.bank","password":"admin2026"}' http://localhost:3000/api/auth/login
curl -b jar.txt http://localhost:3000/api/selftest
```


**What the numbers count:** the selftest runs **14 scenarios** (1 legitimate ALLOW + **13 attack/escalation scenarios**, so "13/13 stopped"). The Attack Lab "All 14 Scenarios" tab shows the same 14, plus a separate Live BillPay agent run. The **benchmark** is a different thing: a labelled dataset (272 samples in `docs/BENCHMARK.md`).

---

## Environment Variables

See `.env.example`. In production (`NODE_ENV=production`) the server refuses to start unless these are set, at least 24 characters, and all different:
- `AGENTSHIELD_JWT_SECRET`: HS256 signing secret for bound delegation JWTs
- `AGENTSHIELD_AUDIT_HMAC_KEY`: HMAC-SHA256 key for Stage 5 audit entries (separate from the JWT secret)
- `BANK_INTERNAL_SECRET`: shared secret authenticating gateway -> bank API calls
- `SESSION_SECRET`: signs session cookies

Optional:
- `DEMO_MODE`: enables the demo shortcuts (preview customer session, role switch, Reset Demo, Tamper button, Attack Lab). Default on outside production, off in production.
- `TRUST_CLIENT_FINGERPRINT`: trust the IP an agent declares. Default follows `DEMO_MODE`; in production the gateway uses the connection address.
- `TRUST_PROXY`: number of proxy hops, so `req.ip` is the real client behind a load balancer.
- `ANTHROPIC_API_KEY`: powers the Live BillPay AI Agent in Attack Lab. Without it a deterministic scripted agent runs.

---

## Demo Credentials

- **Customer Account**: `arjun.sen@example.in` / `arjun2026` (IndiBank Kolkata, Step-up PIN: `2026`)
- **Bank Admin Console**: `admin@agentshield.bank` / `admin2026`

Seeded Indian data includes ₹ balances, CESC Kolkata, Jio Fiber, KMC Water Tax, Bengal Gas Co, Airtel Postpaid, 30 days of historical transactions, and 3 registered agents (`BillPay Autopilot`, `SpendTracker Insights`, `ShopBuddy AI`).

---

## 5-Stage Security Pipeline

Every agent action (`check_balance`, `pay_bill`, `transfer`, `add_payee`) runs sequentially through:

1. **Stage 1 — Identity & Token Binding**: HS256 JWT validation (`jti`, expiry, agent status), SHA-256 fingerprint binding (`agentRuntimeId + IP + ASN + userAgent`), and 60-second timestamp + unique nonce replay defense. Stolen token replay from a foreign IP burns the token and raises an instant customer security alert.
2. **Stage 2 — Scoped Delegation Engine**: Default-deny checks against active customer grants (`allowed_actions`, `allowed_categories`, optional `payee_allowlist`, per-transaction cap, 24h & 30d cumulative spend computed directly from SQLite ledger, expiry, and instant millisecond revocation).
3. **Stage 3 — Behavioural Anomaly, Intent Mismatch & Prompt Injection**: Compares against a 30-day rolling per-agent baseline (amount z-score, unusual hours such as 3 AM, new payee, velocity bursts, structuring/smurfing near ceilings, action-mix switches) plus stated-intent mismatch and `context_provenance` / prompt-injection snippet detection. Baseline stats update **only** on `ALLOW` or customer-approved requests so attackers cannot poison baselines.
4. **Stage 4 — Human-in-the-Loop Escalation**: `ASK_CUSTOMER` verdicts (score 40–69 by default, tunable by Bank Admin) create pending approval tokens pushed over SSE (`/api/events/stream`) and long-polling (`/api/gateway/requests/:id?wait=true`), requiring the customer's step-up PIN (always enforced server-side, locked after 5 wrong tries) before idempotent one-time bank settlement. Customers can tick "Always trust this payee" so future payments to it are not escalated. Unanswered approvals return an explicit `EXPIRED` state to the agent.
5. **Stage 5 — Tamper-Evident Audit Chain**: Append-only `audit_log` chaining `prev_hash -> entry_hash` (SHA-256 over canonical JSON) and `hmac_sig` (HMAC-SHA256). Verifiable live via `/api/audit/verify` and testable via `/api/audit/simulate-tamper`.

---

## Architecture & API Endpoints

- **Mock Bank API (`/api/bank/*`)**: `/accounts`, `/payees`, `/transactions`, `/execute` (requires `x-bank-internal-secret`)
- **AgentShield Gateway (`/api/gateway/*`)**: `/tokens` (signed-in customer, own active grant), `/execute`, `/requests/:id` (owning agent token, customer or admin), `/scenario` and `/live-agent` (demo mode only)
- **Apps & Audit (`/api/*`)**: `/customer/overview`, `/customer/grants`, `/customer/grants/:id/revoke`, `/customer/approvals/:id/resolve`, `/console/overview`, `/console/agents/:id/status`, `/console/settings`, `/audit/logs`, `/audit/verify`, `/audit/simulate-tamper`, `/events/stream` (SSE), `/selftest`, `/docs` (OpenAPI 3.0)
- **TypeScript SDK**: `src/sdk/agentshield-sdk.ts`


---

## Access control summary

| Area | Who can call it |
|---|---|
| `/api/gateway/execute` | Any agent holding a valid, unrevoked, device-bound token |
| `/api/gateway/tokens`, `/api/customer/*` | Signed-in customer, own data only |
| `/api/console/*` | Bank admin |
| `/api/audit/logs` | Signed-in user (customers see only their own entries) |
| `/api/auth/switch-role`, `/api/reset-demo`, `/api/audit/simulate-tamper`, Attack Lab | Demo mode only; return 404 otherwise |
| `/api/events/stream` | Signed-in user; account events go only to the owning customer and admins |

Cookie-authenticated POSTs also reject a mismatched `Origin` header (CSRF), and failed sign-ins are throttled per IP.

## Tests

`npm test` runs the pipeline suite, the web-layer security suite (auth, PIN, ownership, token issuance, scoped events, production config) and a hardening suite (approval re-validation, token redaction, category/allowlist enforcement, cold-start escalation, idempotency scoping, audit-tail truncation).
