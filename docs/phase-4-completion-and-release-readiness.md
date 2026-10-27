# AURIS — PHASE 4 COMPLETION & RELEASE READINESS REPORT
## Provider-Neutral Telephony Gateway, Mock Media Streaming, Security Hardening, Billing Recovery & Release Readiness

**Date:** 2026-10-27  
**Workspace:** `E:\Nothing`  
**Auditor Roles:** Principal Backend Engineer, Distributed Systems Architect, Application Security Specialist, PostgreSQL Concurrency Specialist, Financial Systems Auditor  
**Target Platform:** Auris Voice AI Platform (Phases 1 through 4.1.4)  

---

## 1. Executive Summary and Verdict

### **VERDICT: PASS WITH LIMITATIONS**

The Auris Phase 4 voice telephony platform, media streaming gateway, and billing reconciliation subsystem have been thoroughly audited, hardened, and verified under deterministic, mock-first local conditions.

- **Telephony & Media Streaming Gateway:** The provider-neutral gateway (`/v1/telephony/webhook`, `/v1/telephony/stream-token`, `/v1/telephony/stream`) operates with strict cryptographic HMAC-SHA256 signature verification over canonical raw request bytes, timing-safe equality checks, a 15-second future skew bound, and 300-second expiration. WebSocket media streaming enforces 16,000 Hz, 16-bit signed linear PCM mono audio in 20 ms frames (640 bytes/frame) with bounded queues (100 frames / 64,000 bytes) and transport backpressure.
- **Webhook Idempotency & Conflict Quarantine:** Duplicate webhooks with identical payload hashes are acknowledged idempotently (`200 OK`, `duplicate: true`). Reusing an existing `eventId` with a conflicting or forged payload hash is detected and rejected with `409 Conflict` (`WEBHOOK_PAYLOAD_CONFLICT`). Retried or out-of-order events are strictly prohibited from reviving terminal calls (`COMPLETED`, `FAILED`, `BUSY`, `NO_ANSWER`, `REJECTED`).
- **Financial Invariants & Concurrency:** All 12 financial invariants are enforced with PostgreSQL row locks (`SELECT ... FOR UPDATE`), transaction rollback atomicity, and idempotent deduplication keys. Overdraft balance exhaustion caps debits at remaining credits, protects balances from becoming negative, and durably records provider cost deficits in `wallet_reservations.unpaid_amount`.
- **Recovery Worker Hardening:** The sweeper `reconcileTerminalCallReservations` utilizes an optimized raw SQL join on terminal calls with strict FIFO ordering (`ORDER BY wr.created_at ASC`), eliminating queue starvation across multi-batch executions. Calls with zero duration, missing timestamps, or reversed timestamps (`endedAt < startedAt`) are released with ₹0 charge.
- **Release Readiness & Test Pass Rate:** The complete workspace test suite executes **221 tests across 16 test files, with 221 passing (100%), 0 failing, and 0 skipped** (51 in `@auris/runtime`, 170 in `@auris/api`). All 4 workspaces compile cleanly with **Exit Code 0** (`npm run build`).

### **Operational Limitations for Production Release:**
1. **No Standalone Sweeper Scheduler Daemon:** Recovery is executed synchronously on webhook disconnects and retries. A background scheduler process (e.g. BullMQ, pg_cron, or Kubernetes CronJob) must be provisioned to invoke `reconcileTerminalCallReservations` periodically in production.
2. **Process-Local Stream Token Nonces:** Stream token single-use nonce tracking resides in an in-memory `Map`. Multi-node horizontal scaling requires external atomic nonce persistence (e.g., Redis).
3. **Prepaid Debt Collection Policy:** Subsequent wallet top-ups credit funds directly without automatically clawing back past provider debt (`unpaid_amount`). This policy requires product owner alignment before enabling postpaid features.
4. **Mock-Only Telephony Boundary:** All carrier integrations, media frames, and PSTN events are strictly simulated in local mock harnesses.

---

## 2. Actual Repository Baseline

### 2.1 Workspace Structure
Auris is structured as an npm workspaces monorepo:
1. **`@auris/database` (`packages/database`):** Prisma ORM layer with PostgreSQL schema definitions, migrations, and generated client.
2. **`@auris/runtime` (`packages/runtime`):** Provider-neutral call orchestration, state machines, audio frame buffers, WebSocket media streaming sessions, and mock adapters.
3. **`@auris/api` (`apps/api`):** Fastify v5 server providing REST endpoints, authentication (JWT), tenant authorization, telephony webhooks, wallet transactions, and WebSocket streaming gateway.
4. **`@auris/web` (`apps/web`):** Next.js 15 dashboard for organization management, agent configuration, wallet balance monitoring, and call inspection.

### 2.2 Git State & Database Configuration
- **Git Status:** Directory is an uninitialized Git repository (`fatal: not a git repository`). No branches changed, no commits created.
- **Database Engine:** PostgreSQL (running on `localhost:5434`, database: `auris_db`).
- **Target Boundaries:** Local loopback `127.0.0.1` binding; mock-only telephony adapters; no live external credentials or payment gateways configured.

---

## 3. Phase 4 Features Found and Verified

| Feature | Implementation Path | Verification Status |
|---|---|---|
| **Webhook Ingestion** | `apps/api/src/modules/telephony/telephony.routes.ts` (`POST /v1/telephony/webhook`) | **Verified**: Raw body parsing, HMAC verification, replay rejection, conflict quarantine. |
| **Stream Token Issuance** | `apps/api/src/modules/telephony/telephony.routes.ts` (`POST /v1/telephony/stream-token`) | **Verified**: 300s TTL, single-use nonce, call & tenant authorization binding. |
| **Media Stream WebSocket** | `apps/api/src/modules/telephony/telephony.routes.ts` (`GET /v1/telephony/stream`) | **Verified**: Fastify WebSocket, stream token consumption, database state verification. |
| **Audio Format Convention** | `packages/runtime/src/telephony/MediaStreamSession.ts` | **Verified**: 16,000 Hz, 16-bit signed PCM, mono, 20 ms frames (640 bytes/frame). |
| **Bounded Media Queues** | `packages/runtime/src/telephony/MediaStreamSession.ts` | **Verified**: Max 100 frames (64,000 bytes) outbound queue; backpressure monitoring. |
| **Transport Backpressure** | `packages/runtime/src/telephony/MediaStreamSession.ts` | **Verified**: Pauses STT/TTS pushing when `ws.bufferedAmount > 64000`. |
| **Socket Cleanup on Supersede** | `packages/runtime/src/telephony/MediaStreamSession.ts` | **Verified**: Old sockets closed with code 1000 (`SUPERSEDED`), listeners removed. |

---

## 4. Phase 4.1.1 Crash-Recovery Verification

- **Problem Addressed:** Webhook event recorded in database (`carrier_webhook_events`) while downstream call status synchronization aborted due to a simulated database failure. On subsequent retry, the unique constraint `P2002` treated the event as a duplicate and skipped applying the missing call status transition.
- **Architectural Solution Verified:**
  1. **Atomic Transaction Boundary:** `tx.carrierWebhookEvent.create` and `syncCallStatus(callId, event, tx)` are wrapped inside an atomic `prisma.$transaction`. If call state update fails, the event record is rolled back, allowing clean retries.
  2. **Idempotent Effect Recovery:** In the `P2002` catch block, `TelephonyService` invokes `syncCallStatus(callId, event)` to guarantee that any previously incomplete call transitions converge to their final state (`COMPLETED`/`IN_PROGRESS`).
  3. **Cold-Restart Mapping Hydration:** If `TelephonyGateway.providerCallMap` is empty following a cold process restart, `TelephonyService` re-hydrates the mapping by querying `prisma.call.findUnique({ where: { carrierCallId } })`.
- **Proving Tests:** [webhook_crash_recovery.test.ts](file:///e:/Nothing/apps/api/tests/webhook_crash_recovery.test.ts) (5 tests).

---

## 5. Phase 4.1.2 Durable Billing Recovery Verification

- **Problem Addressed:** A call terminated in the database without an active in-memory session (e.g. following process restart or lost WebSocket), leaving its financial pre-authorization reservation in `HELD` status indefinitely.
- **Architectural Solution Verified:**
  1. **Step 5 Webhook Financial Reconciliation:** `TelephonyService.handleWebhook` invokes `reconcileCallReservation(callId)` upon initial disconnect/failed events and upon duplicate retries, settling or releasing reservations immediately even if no in-memory session exists.
  2. **Durable Sweeper Reconciliation:** `WalletService.reconcileTerminalCallReservations` queries PostgreSQL for any outstanding `HELD` reservations where the underlying call has reached a terminal status.
  3. **Row-Level Concurrency Locks:** Both methods utilize `SELECT ... FOR UPDATE` inside `WalletService.settleCall` and `releaseReservation`, preventing race conditions between concurrent webhooks and sweeper workers.
- **Proving Tests:** [durable_effects_and_billing_recovery.test.ts](file:///e:/Nothing/apps/api/tests/durable_effects_and_billing_recovery.test.ts) (5 tests).

---

## 6. Phase 4.1.3 Financial Invariant Verification

- **Problem Addressed:** Queue starvation in recovery sweeper due to unindexed application-level filtering, omission of non-completed terminal statuses (`BUSY`, `NO_ANSWER`), billing calls with reversed timestamps (`endedAt < startedAt`), and accepting forged payloads on reused event IDs.
- **Architectural Solution Verified:**
  1. **Raw SQL Terminal Filter & FIFO Ordering:** Replaced application-level scans with a raw SQL join filtering `c.status::text IN ('COMPLETED', 'FAILED', 'REJECTED', 'BUSY', 'NO_ANSWER') OR (c.id IS NULL AND wr.expires_at < NOW())` and `ORDER BY wr.created_at ASC LIMIT ${limit}`.
  2. **Non-Billable & Reversed Timestamp Protection:** `reconcileTerminalCallReservations` validates duration strictly (`duration > 0 && endedAt > startedAt`). Unanswered, busy, zero-duration, or clock-drift reversed calls are cancelled with ₹0 charge.
  3. **Conflicting Payload Hash Quarantine:** In `handleWebhook`, when `P2002` is encountered, `existingEvent.payloadHash` is compared against `rawHash`. If hashes differ, a `WEBHOOK_PAYLOAD_CONFLICT` error is thrown, mapped to HTTP 409 Conflict.
- **Proving Tests:** [financial_invariants_and_recovery_hardening.test.ts](file:///e:/Nothing/apps/api/tests/financial_invariants_and_recovery_hardening.test.ts) (13 tests).

---

## 7. Phase 4.1.4 Release-Readiness Verification

- **Verification Executed:** An independent, end-to-end audit test suite ([release_readiness_audit_phase_4_1_4.test.ts](file:///e:/Nothing/apps/api/tests/release_readiness_audit_phase_4_1_4.test.ts)) was authored to verify the platform under real PostgreSQL concurrency:
  1. **Zero Balance & Pre-Auth Hold:** Confirmed zero-balance wallets reject reservation creation with `INSUFFICIENT_FUNDS`.
  2. **Mid-Call Lease Extension:** Proved `extendReservation` returns `action: 'TERMINATE_CALL'` when balance is insufficient, allowing graceful termination before carrier overdraft.
  3. **Balance Exhaustion & Debt Durability:** Proved settlement exceeding available balance caps at remaining credits, keeps balance at `0.0`, preserves `unpaid_amount` in PostgreSQL, and records ledger description.
  4. **Non-Finite Value Rejection:** Proved `calculateCallCharge` returns `{ billableSeconds: 0, chargeAmount: 0 }` for `NaN`, `Infinity`, `-Infinity`, `-30s`, and `0s`.
  5. **Multi-Batch FIFO Starvation Avoidance:** Created 5 terminal reservations and drained them in 3 consecutive batches with `limit = 2`. Verified strict chronological execution order (`[0, 1] -> [2, 3] -> [4]`).
  6. **Multi-Worker Concurrency:** Ran 4 concurrent recovery workers across the same pending reservations; proved exactly 1 settlement and 1 ledger transaction per call without deadlocks.
  7. **Fault Injection & Test Detection:** Demonstrated that omitting payload hash checks or SQL timestamp ordering would cause tests to fail, validating that test assertions are active defect detectors.

---

## 8. Security Findings and Remediation Summary

| Finding ID | Severity | Component | Summary & Fix Applied | Status |
|---|---|---|---|---|
| **SEC-01** | High | `TelephonyGateway` | Server-authoritative mapping prevents cross-tenant `callId` injection in webhooks. | **Remediated** |
| **SEC-02** | High | `TelephonyGateway` | Missing signature validation on webhooks. Added HMAC-SHA256 verification. | **Remediated** |
| **SEC-03** | High | `MediaStreamSession` | Socket leak on reconnection. Added `SUPERSEDED` socket closure and listener removal. | **Remediated** |
| **SEC-04** | Medium | `TelephonyGateway` | Unbounded stream token TTL. Reduced TTL to 300s and added single-use nonce tracking. | **Remediated** |
| **SEC-05** | Low | `TelephonyGateway` | Relaxed hex signature validation. Added strict 64-char lowercase hex regex checks. | **Remediated** |
| **SEC-06** | Low | `TelephonyGateway` | Asymmetric timestamp skew. Added 15s future-skew bound and replay window. | **Remediated** |
| **SEC-07** | Low | `TelephonyGateway` | Unbounded media queues. Enforced 100-frame (64,000 byte) queue bounds with backpressure. | **Remediated** |
| **SEC-08** | Medium | `TelephonyService` | Reused event ID with conflicting payload. Added SHA-256 payload hash check (409 Conflict). | **Remediated** |
| **CRASH-01**| High | `TelephonyService` | Webhook event loss on crash. Added atomic `$transaction` and retry effect recovery. | **Remediated** |
| **REL-01**  | Medium | `TelephonyRoutes` | WebSockets accepted media on terminal calls. Added DB authorization gating. | **Remediated** |
| **TEST-01** | Low | `Vitest Config` | Parallel test race on shared DB. Added `fileParallelism: false` and `organizationId` scoping. | **Remediated** |

---

## 9. Financial Correctness Findings

| Finding ID | Severity | Component | Summary & Fix Applied | Status |
|---|---|---|---|---|
| **BILL-01** | High | `WalletService` | Completed call orphaned in HELD on crash. Added Step 5 webhook reconciliation and sweeper. | **Remediated** |
| **BILL-02** | High | `WalletService` | Queue starvation & reversed timestamp charges. Added raw SQL FIFO join and duration guards. | **Remediated** |
| **BILL-03** | Low / Arch | `WalletService` | Balance exhaustion caps at 0; debt preserved in `unpaid_amount`. Top-up limitation documented. | **Documented** |

---

## 10. Complete Test Results

### Test Execution Summary
- **Execution Command:** `npm test`
- **Total Test Files:** 16
- **Total Tests Executed:** **221**
- **Passed:** **221 (100%)**
- **Failed:** **0**
- **Skipped:** **0**

### Breakdown by Workspace

#### `@auris/runtime` (3 test files, 51 tests passed)
- `tests/telephony_audit.test.ts` (8 tests) — Token issuance, cross-tenant spoofing, socket supersede, replay protection.
- `tests/telephony_contracts.test.ts` (30 tests) — Payload validation, normalization, event serialization, error models.
- `tests/runtime_voice_lifecycle.test.ts` (13 tests) — Voice session lifecycle, turn chunking, interruption/barge-in.

#### `@auris/api` (13 test files, 170 tests passed)
- `tests/release_readiness_audit_phase_4_1_4.test.ts` (18 tests) — Balance exhaustion, debt durability, multi-batch FIFO, 4 concurrent workers, non-finite duration guards, fault injection.
- `tests/financial_invariants_and_recovery_hardening.test.ts` (13 tests) — Invariants 1-12, conflicting payload quarantine, terminal revival protection, FIFO order, orphan hold release.
- `tests/durable_effects_and_billing_recovery.test.ts` (5 tests) — Post-restart hydration, idempotent retry settlement, concurrent settle vs release.
- `tests/webhook_crash_recovery.test.ts` (5 tests) — Atomic event insertion rollback, call state recovery, cold-restart mapping.
- `tests/telephony_audit_and_concurrency.test.ts` (5 tests) — Webhook signature verification, replay cache, WebSocket auth gating.
- `tests/telephony_gateway.test.ts` (16 tests) — Telephony gateway routing, stream tokens, WebSocket framing.
- `tests/runtime_concurrency_and_recovery.test.ts` (35 tests) — Crash recovery, lease extensions, concurrent turn loops, resource cleanup.
- `tests/authorization_and_wallet_integrity.test.ts` (22 tests) — Wallet pre-auth, settle, release, tenant authorization.
- `tests/frontend_api_integration.test.ts` (19 tests) — Auth, registration, session cookies, agent management.
- `tests/billing_and_tenancy.test.ts` (11 tests) — Multi-tenant billing, credit transactions, low balance thresholds.
- `tests/auth_and_security.test.ts` (10 tests) — JWT validation, token tampering, expiry checks.
- `tests/runtime_integration.test.ts` (6 tests) — End-to-end voice runtime DB lifecycle, transcripts, 30s block settlement.
- `tests/agent_management.test.ts` (5 tests) — Agent CRUD, versioning, prompt templates.

---

## 11. Complete Build Results

- **Execution Command:** `npm run build`
- **Overall Exit Code:** **0**
- **Sub-Package Build Status:**
  - `@auris/database`: `tsc` -> **Success (Exit Code: 0)**
  - `@auris/runtime`: `tsc` -> **Success (Exit Code: 0)**
  - `@auris/api`: `tsc` -> **Success (Exit Code: 0)**
  - `@auris/web`: `next build` -> **Success (Exit Code: 0)**, static route optimization completed.

---

## 12. Files Changed and Summary of Modifications

1. [apps/api/src/modules/wallets/wallet.service.ts](file:///e:/Nothing/apps/api/src/modules/wallets/wallet.service.ts)
   - Replaced unindexed HELD reservation query in `reconcileTerminalCallReservations` with raw SQL inner-join on terminal call statuses (`COMPLETED`, `FAILED`, `BUSY`, `NO_ANSWER`, `REJECTED`) and expired orphan holds.
   - Enforced strict FIFO ordering (`ORDER BY wr.created_at ASC LIMIT ${limit}`).
   - Added optional `organizationId?: string` parameter for isolated multi-tenant and test sweeps.
   - Added duration validation: non-billable, zero duration, or reversed timestamps are released with ₹0 charge.
   - Enforced non-finite value rejection (`NaN`, `Infinity`, `<= 0`) in `calculateCallCharge`.
2. [apps/api/src/modules/telephony/telephony.service.ts](file:///e:/Nothing/apps/api/src/modules/telephony/telephony.service.ts)
   - In `handleWebhook` `P2002` catch block, queried `existingEvent.payloadHash` and compared against `rawHash`. If hashes differ, throws `WEBHOOK_PAYLOAD_CONFLICT` (HTTP 409).
   - In `syncCallStatus`, guarded against out-of-order or retried webhooks mutating calls in terminal statuses.
   - In `reconcileCallReservation`, included all terminal statuses and validated duration before settling.
3. [apps/api/src/modules/telephony/telephony.routes.ts](file:///e:/Nothing/apps/api/src/modules/telephony/telephony.routes.ts)
   - Mapped `WEBHOOK_PAYLOAD_CONFLICT` error to HTTP 409 Conflict.
4. [apps/api/vitest.config.ts](file:///e:/Nothing/apps/api/vitest.config.ts)
   - Added `fileParallelism: false` to ensure test files execute deterministically against the shared local PostgreSQL database.
5. [apps/api/tests/financial_invariants_and_recovery_hardening.test.ts](file:///e:/Nothing/apps/api/tests/financial_invariants_and_recovery_hardening.test.ts)
   - Added Phase 4.1.3 regression tests covering Invariants 1-12, payload hash conflict detection, terminal revival protection, FIFO recovery, and orphan release.
6. [apps/api/tests/release_readiness_audit_phase_4_1_4.test.ts](file:///e:/Nothing/apps/api/tests/release_readiness_audit_phase_4_1_4.test.ts)
   - Added Phase 4.1.4 independent verification tests covering balance exhaustion, mid-call extension termination, unpaid debt durability, multi-batch FIFO, 4 concurrent workers, non-finite duration guards, and fault injection validation.
7. [docs/phase-4.1-security-audit.md](file:///e:/Nothing/docs/phase-4.1-security-audit.md)
   - Updated comprehensive security audit log with findings `TEST-01`, `BILL-03`, coverage matrix, and test counts.

---

## 13. Database Schema and Migration Analysis

- **Prisma Migrations:** No schema modifications or database migrations were required.
- **Existing Schema Utilization:**
  - `WalletReservation.unpaid_amount`: Utilized to durably record carrier cost deficits during balance exhaustion.
  - `CarrierWebhookEvent.payload_hash`: Utilized for SHA-256 conflict detection on reused event IDs.
  - `CreditTransaction.idempotency_key`: Utilized to enforce ledger uniqueness.
  - `Call.carrier_call_id`: Unique index utilized for post-restart call mapping hydration.

---

## 14. Known Limitations

1. **Local-Only Mock Telephony:** Tested strictly against the local mock telephony provider and mock media streams. Real carrier protocol nuances (Twilio TwiML / Plivo XML / carrier SIP gateways) were not tested and must not be used until authorized.
2. **Distinction Between Process Restart and In-Memory Continuity:** Cold process restarts clear in-memory Maps and sessions. Database hydration successfully recovers carrier mappings (`carrier_call_id`) and resolves orphaned financial reservations. However, active conversation turns, audio buffers, and live WebSocket connections cannot be reconstructed after process termination without re-establishing client transport.
3. **Recovery Worker Scheduling Limitation:** In the current architecture, `reconcileTerminalCallReservations` is executed programmatically or upon webhook disconnect/failure events. There is no active standalone background cron process running by default in the local development environment; production deployment will require a scheduled task runner (e.g. pg_cron, BullMQ, or Kubernetes CronJob) to periodically invoke the sweeper.
4. **Simulated Partial Failures vs Hard OS Kill:** Partial failures were validated via injected exceptions, detached runtime sessions, aborted connections, and rolled-back database transactions. Hard OS-level `SIGKILL` tests were avoided to protect local background tooling.
5. **Single-Process Nonce Scope:** Stream token single-use nonce tracking is held in local process memory (`Map`). Distributed deployments across multiple server containers will require external atomic nonce persistence (e.g., Redis or transactional database table).
6. **Prepaid Balance Exhaustion & Debt Collection Limitation:** When a call's duration exceeds the customer's wallet balance, debits are capped at the remaining balance (preventing negative balances), and the provider cost deficit is durably preserved in `wallet_reservations.unpaid_amount`. However, subsequent wallet top-ups do not automatically deduct previously accumulated unpaid debts; automatic debt clawback must be implemented if post-paid / hybrid billing is required.

---

## 15. Operational Instructions for Manually Invoking or Testing Recovery

### 15.1 Manual Sweeper Invocation (Programmatic / Node.js)
```typescript
import { PrismaClient } from '@auris/database';
import { WalletService } from './apps/api/src/modules/wallets/wallet.service.js';

const prisma = new PrismaClient();
const walletService = new WalletService(prisma);

// Reconcile up to 50 pending terminal reservations globally across all organizations:
const results = await walletService.reconcileTerminalCallReservations(50);
console.log(`Reconciled ${results.length} terminal reservations.`);

// Or reconcile for a specific tenant:
const tenantResults = await walletService.reconcileTerminalCallReservations(50, 'target-org-uuid');
```

### 15.2 Webhook Disconnect Simulation
```bash
# Deliver signed mock disconnect webhook to trigger immediate Step 5 reconciliation:
curl -X POST http://127.0.0.1:4000/v1/telephony/webhook \
  -H "Content-Type: application/json" \
  -H "x-auris-signature: t=1700000000,v1=<computed-hmac>" \
  -d '{
    "eventType": "call.disconnected",
    "eventId": "evt-manual-1",
    "carrierCallId": "carrier-call-uuid",
    "duration": 45
  }'
```

### 15.3 Running the Test Harness
```bash
# Run all recovery and invariant tests:
npm run --workspace=@auris/api test tests/financial_invariants_and_recovery_hardening.test.ts
npm run --workspace=@auris/api test tests/release_readiness_audit_phase_4_1_4.test.ts

# Run entire test suite across all packages:
npm test
```

---

## 16. Remaining Decisions Requiring Product-Owner Approval

1. **Unpaid Debt Collection on Top-Up:**
   - *Current Behavior:* When a call overruns balance, the unpaid deficit is recorded in `wallet_reservations.unpaid_amount` and described in ledger history, but the wallet balance is capped at `0.0`. When the user later tops up ₹100, their balance becomes ₹100 without deducting past unpaid amounts.
   - *Options for Product Owner:*
     - **Option A (Current / Pure Prepaid):** Forgive overdraft cost; provider cost absorbed by platform as churn risk.
     - **Option B (Debt Recovery on Top-up):** Automatically deduct accumulated `unpaid_amount` from subsequent top-ups until deficit is cleared.
     - **Option C (Account Restriction):** Block new outbound calls or agent execution if an organization has `unpaid_amount > 0` until settled manually.
2. **Background Scheduler Daemon Infrastructure:**
   - Select production mechanism for periodically invoking `reconcileTerminalCallReservations(50)`:
     - **Option A:** PostgreSQL `pg_cron` running a lightweight SQL function or API webhook.
     - **Option B:** Redis-backed BullMQ repeatable job runner worker pod.
     - **Option C:** Kubernetes CronJob pod invoking an authenticated internal maintenance endpoint every 60 seconds.
3. **Distributed Nonce Storage:**
   - Replace the in-memory stream token nonce `Map` with a Redis cluster key (`SET nonce EX 300 NX`) prior to deploying more than 1 replica of `@auris/api`.

---

## 17. Checklist for Next Phase (Phase 4.2: Mock-First Carrier Adapter Design)

- [ ] Maintain the strict safety boundary: **no real telephony providers, no real credentials, no real calls/SMS, no public endpoints**.
- [ ] Implement carrier-specific payload mappers (Twilio Media Streams / Plivo Audio Streams format adapters) strictly using deterministic mock test harnesses.
- [ ] Design bidirectional media protocol translation between Auris internal 16kHz linear PCM and carrier formats (e.g. 8kHz μ-law/G.711).
- [ ] Define normalized carrier webhook parser interface supporting event types: `initiated`, `ringing`, `answered`, `disconnected`, `failed`, `dtmf`, and `media`.
- [ ] Formulate distributed stream token nonce storage abstraction before any multi-instance deployment.

---

# DESIGN OUTLINE: PHASE 4.2 — MOCK-FIRST CARRIER ADAPTER DESIGN

## 1. Provider-Neutral Carrier Adapter Contract

```typescript
export interface ICarrierAdapter {
  readonly carrierName: 'twilio' | 'plivo' | 'telnyx' | 'mock';

  /** Validate carrier-specific webhook signature headers */
  validateWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean;

  /** Normalize vendor webhook payloads into canonical Auris TelephonyEvent */
  normalizeWebhookPayload(rawPayload: Record<string, any>): NormalizedCarrierEvent;

  /** Translate incoming vendor WebSocket messages to internal 20ms 16kHz PCM audio frames */
  decodeMediaFrame(vendorMessage: string | Buffer): AudioFrame;

  /** Translate internal 20ms 16kHz PCM audio frames to vendor-specific media WebSocket messages */
  encodeMediaFrame(frame: AudioFrame, streamSid: string): string | Buffer;

  /** Format carrier-specific initial call instructions (e.g. TwiML <Connect><Stream>, Plivo XML) */
  generateConnectResponse(params: { streamUrl: string; streamToken: string; callId: string }): string;
}
```

## 2. Mock Inbound and Outbound Lifecycle Simulations
- **Deterministic Mock Harness:** Implement a `MockCarrierSandbox` class capable of simulating carrier state transitions with configurable network jitter and packet loss:
  1. `DIALING` -> `RINGING` (180 Ringing) -> `ANSWERED` (200 OK) -> `MEDIA_STREAM_ACTIVE` -> `HANGUP` (BYE).
  2. Failure conditions: `BUSY` (486), `NO_ANSWER` (408), `REJECTED` (603), `CARRIER_ERROR` (500).
- **Out-of-Order Delivery Testing:** Simulate delivery of `disconnected` before `answered` to verify carrier adapter resilience.

## 3. Normalized Event Mapping

| Vendor Event (e.g. Twilio) | Vendor Event (e.g. Plivo) | Canonical Auris Event Type | Terminal? | Billable? |
|---|---|---|---|---|
| `initiated` | `initiated` | `call.initiated` | No | No |
| `ringing` | `ringing` | `call.ringing` | No | No |
| `in-progress` / `answered` | `answered` | `call.answered` | No | Yes (upon disconnect) |
| `completed` | `hangup` | `call.disconnected` | Yes | Yes (if duration > 0) |
| `busy` | `busy` | `call.busy` | Yes | No |
| `no-answer` | `timeout` | `call.no_answer` | Yes | No |
| `failed` | `failed` | `call.failed` | Yes | No |

## 4. Mock Media-Stream Lifecycle & Audio Boundaries
- **Carrier Audio Codec Boundary:**
  - Twilio & Plivo stream audio as 8,000 Hz μ-law (G.711u) base64-encoded in JSON frames.
  - Auris voice runtime expects 16,000 Hz 16-bit linear PCM.
  - Implement a dedicated `AudioResampler` and `MuLawCodec` inside `@auris/runtime`:
    - Inbound: `base64 μ-law (8kHz)` -> `PCM 16-bit (8kHz)` -> `Polyphase Resample` -> `PCM 16-bit mono 16kHz (640 bytes/20ms)`.
    - Outbound: `PCM 16-bit mono 16kHz` -> `Downsample to 8kHz` -> `PCM to μ-law` -> `base64 JSON packet`.

## 5. Reconnection and Error Simulation
- **Transient WebSocket Disconnect:** Socket drops mid-call; adapter buffers up to 50 outbound frames (1 second of audio) while carrier attempts WebSocket reconnection with same `streamSid`.
- **Duplicate Stream Token Reconnection:** Verify that a dropped socket reconnecting with the same valid token can resume media without creating duplicate reservations.

## 7. Phase 4.2 Implementation & Verification Update

As of Phase 4.2, the carrier adapter abstraction, deterministic mock sandbox, and audio codec boundaries have been formally implemented and verified:
- **`ICarrierAdapter` Interface:** Unified carrier abstraction in `packages/runtime/src/telephony/ICarrierAdapter.ts`.
- **G.711 μ-Law Codec (`G711MuLawCodec`):** Full ITU-T G.711 companding with reference vectors, clipping, and linear interpolation resampling in `packages/runtime/src/telephony/AudioCodec.ts`.
- **`MockCarrierSandbox`:** Deterministic fault-injection sandbox supporting configurable delays, drops, duplicates, timeouts, and initiation failures in `packages/runtime/src/telephony/MockCarrierSandbox.ts`.
- **`IStreamTokenNonceStore` & `IRecoveryScheduler`:** Distributed replay protection and recovery scheduler interfaces implemented in `packages/runtime/src/telephony/`.
- **Test Suite Status:** Full workspace suite expanded to **267 passing tests** (88 in `@auris/runtime`, 179 in `@auris/api`), 0 failures, 0 skipped.
- **Reference Documentation:**
  - Architecture: [`docs/phase-4-2-carrier-adapter-architecture.md`](file:///e:/Nothing/docs/phase-4-2-carrier-adapter-architecture.md)
  - Sandbox Guide: [`docs/phase-4-2-mock-sandbox-guide.md`](file:///e:/Nothing/docs/phase-4-2-mock-sandbox-guide.md)
  - Security & Reliability: [`docs/phase-4-2-security-and-reliability.md`](file:///e:/Nothing/docs/phase-4-2-security-and-reliability.md)
  - Completion Report: [`docs/phase-4-2-completion-report.md`](file:///e:/Nothing/docs/phase-4-2-completion-report.md)

---

### End of Phase 4 & Phase 4.2 Master Deliverables. Standing by for User Direction.
