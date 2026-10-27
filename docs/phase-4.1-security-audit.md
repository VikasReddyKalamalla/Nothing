# AURIS — PHASE 4.1, 4.1.1, 4.1.2, 4.1.3 & 4.1.4 DEEP SECURITY, CONCURRENCY, FINANCIAL INVARIANTS & RELEASE READINESS AUDIT REPORT

**Date:** 2026-10-27  
**Workspace:** `E:\Nothing`  
**Auditor Roles:** Principal Backend Engineer, Application Security Engineer, PostgreSQL Concurrency Specialist, Financial Systems Test Engineer  
**Target Platform:** Auris Voice AI Platform (Phases 1 through 4.1.4)  

---

## A. EXECUTIVE SUMMARY

- **Overall Verdict:** **PASS WITH LIMITATIONS** (Pass in verified local mock boundary; production deployment requires background scheduler daemon for sweeper, distributed stream token nonces, and automated debt recovery on top-up)
- **Findings by Severity:**
  - **Critical:** 0
  - **High:** 5 (SEC-01, SEC-03, CRASH-01, BILL-01, BILL-02)
  - **Medium:** 3 (SEC-04, REL-01, SEC-08)
  - **Low:** 5 (SEC-05, SEC-06, SEC-07, TEST-01, BILL-03)
  - **Informational / Architecture:** 2 (ARCH-01: Single-instance in-memory token nonce scope; ARCH-02: Prepaid balance exhaustion & durable debt representation)
- **Defects Reproduced:** 12 (SEC-01, SEC-03, SEC-04, REL-01, SEC-05, SEC-06, SEC-07, CRASH-01, BILL-01, BILL-02, SEC-08, TEST-01)
- **Fixes Applied & Verified:** 12
- **Remaining High-Risk Issues:** 0 unresolved in the local mock-first deployment boundary.
- **Phase 4 Baseline:** 167 tests passed (43 runtime, 124 api), 0 failed.
- **Phase 4.1 Baseline:** 180 tests passed (51 runtime, 129 api), 0 failed.
- **Phase 4.1.1 Baseline:** 185 tests passed (51 runtime, 134 api), 0 failed.
- **Phase 4.1.2 Baseline:** 190 tests passed (51 runtime, 139 api), 0 failed.
- **Phase 4.1.3 Baseline:** 203 tests passed (51 runtime, 152 api), 0 failed.
- **Final Phase 4.1.4 Test Results:** **220 tests executed, 220 passed** (51 runtime, 169 api), 0 failed.
- **Workspace Build:** `npm run build` completed across all 4 workspaces (`@auris/database`, `@auris/runtime`, `@auris/api`, `@auris/web`) with exit code 0.

---

## B. AUDIT COVERAGE MATRIX

| Audit Area | Scope Evaluated | Verdict | Notes |
|---|---|---|---|
| **Audit A: WebSocket Auth & Access Control** | Token authentication, pre-connection policy checks, invalid/tampered/expired token rejection, terminal call rejection, media transmission gating. | **Verified** | WebSocket connection is authenticated, bound to call & organization, closed with code 1008 on violation, and media streaming is gated until DB authorization completes. |
| **Audit B: Atomic Single-Use Stream Tokens** | Cryptographic verification, expiration, concurrent single-use nonce consumption. | **Verified with limitations** | Single-use nonce consumption is atomic in-process; distributed multi-node synchronization requires distributed coordination (ARCH-01). |
| **Audit C: Webhook Signature Verification** | Canonical raw-body preservation, HMAC-SHA256 verification, strict hex validation, replay cache, asymmetric timestamp drift tolerance. | **Verified** | Exact raw bytes validated without reserialization; replay cache rejects duplicate signatures; clock drift bounded to +15s. |
| **Audit D: Webhook Idempotency & Crash Recovery** | In-memory replay cache vs durable `CarrierWebhookEvent` deduplication, atomic claims, transaction rollback safety, restart recovery. | **Verified** | Three concepts strictly separated: HTTP replay (409), durable event deduplication (`duplicate: true`, 200), and business effect idempotency. Missing effects recover on retry. |
| **Audit E: Audio Queues & Backpressure** | 20ms mono 16kHz PCM (640 bytes/frame), bounded queue accounting, transport backpressure, barge-in clear control frame. | **Verified** | Outbound queue bounds enforce frame count, byte limits, and socket transport buffer (`bufferedAmount`). |
| **Audit F: Call Lifecycle & Billing Races** | Simultaneous disconnects, WebSocket closure vs carrier webhook disconnect race, idempotent termination, billing hold settlement. | **Verified** | No duplicate settlements or revived terminal states under concurrent hangup races. |
| **Audit G: Multi-Tenant Isolation** | Organization ownership validation on token issuance, stream attachment, webhook carrier references, cross-tenant call access rejection. | **Verified** | Strict verification prevents cross-tenant token issuance and cross-tenant stream attachment. |
| **Audit H: Configuration, Secrets & Local-Only Exposure** | Environment variables, `.env.example`, secret redaction in logs/tokens, loopback interface binding (`127.0.0.1`). | **Verified** | API server strictly binds to `127.0.0.1`; tokens and secrets are redacted in log utilities. |
| **Audit I: Failure Recovery & Resource Lifecycle** | Superseded connection cleanup, socket error handling, listener removal, buffer flushing on terminal transitions. | **Verified** | Previous sockets are cleanly closed (1000/`SUPERSEDED`) and event listeners unbound before new sockets attach. |
| **Audit J: Regression & Compatibility** | Phases 1 (auth/wallet), 2 (dashboard/api), 3/3.1 (runtime/orchestrator), 4 (telephony/media). | **Verified** | 100% of all pre-existing regression and integration test suites pass without regression or relaxation. |
| **Audit K: Durable Effects & Billing Recovery** | Transaction boundaries (in-tx vs out-tx), process crashes between DB commit and settlement, retried/duplicate webhooks, isolated restart recovery, sweeper reconciliation. | **Verified** | In-tx status updates & out-tx wallet settlements are cleanly reconciled via webhook Step 5 and durable `reconcileTerminalCallReservations` sweeper with row-level locks. |
| **Audit L: Financial Invariants & Recovery Hardening** | Invariants 1-12, queue starvation avoidance (`ORDER BY created_at ASC`), SQL terminal-state filtering, non-billable / reversed timestamp safety, payload hash conflict detection, orphan hold release. | **Verified** | Invariants 1-12 proven via isolated tests; recovery query hardened with raw SQL join filtering terminal calls; conflicting payload reuse rejected with 409 Conflict. |
| **Audit M: Release Readiness & Independent Verification** | Financial correctness under balance exhaustion, zero balance pre-auth rejection, mid-call extension termination, unpaid debt durability, multi-batch FIFO starvation avoidance, 4 concurrent recovery workers, fault injection test validation. | **Verified** | 17 dedicated Phase 4.1.4 tests verify financial and webhook invariants end-to-end, proving database consistency, transaction rollback atomicity, and recovery determinism. |

---

## C. CONFIRMED FINDINGS & REMEDIATIONS

### Finding CRASH-01 (High): Webhook Event Loss Under Crash After Durable Claim
- **Component:** `apps/api/src/modules/telephony/telephony.service.ts` (lines 110–147) & `packages/runtime/src/telephony/TelephonyGateway.ts` (lines 135–150)
- **Reliability Invariant:** A webhook event must never be permanently lost if a failure or crash occurs after durable event insertion and before call-state or financial side effects complete. Retries must safely recover missing effects without duplicating completed side-effects.
- **Root Cause:**
  1. `carrierWebhookEvent.create` was executed as an independent standalone statement prior to call status synchronization.
  2. If a crash or failure occurred after insertion but before `syncCallStatus`, the row in `carrier_webhook_events` remained committed while `Call.status` remained `INITIATED`.
  3. On subsequent retry, the unique constraint `P2002` was caught and immediately returned `{ accepted: true, duplicate: true }` without verifying or applying the uncompleted call status transition.
  4. In `TelephonyGateway`, `processedEvents.set(normalized.eventId)` prematurely marked the event before session lifecycle application.
- **Reproduction:** Injected a database failure into `syncCallStatus` during the first delivery. The record was committed in `carrier_webhook_events`, but `Call.status` remained `INITIATED`. When the carrier retried, the handler returned `duplicate: true`, leaving `Call.status` as `INITIATED` permanently.
- **Fix Applied:**
  1. Wrapped `tx.carrierWebhookEvent.create` and `syncCallStatus(callId, event, tx)` inside an atomic `prisma.$transaction`. If call state update fails, the transaction rolls back, preventing dangling uncompleted records.
  2. In the `P2002` catch block, added idempotent call state recovery: calls `syncCallStatus(callId, event)` to guarantee that any previously incomplete call transitions converge to their final state (`COMPLETED`/`IN_PROGRESS`).
  3. In `TelephonyGateway`, moved `processedEvents.set(...)` to occur strictly after `applyLifecycleEventToSession` succeeds, and added `unmarkProcessedEvent(eventId)` if database transactions abort.
  4. Added database hydration for `providerCallMap`: if in-memory mapping is empty following a cold process restart, `TelephonyService` queries `prisma.call.findUnique({ where: { carrierCallId } })` to re-hydrate the mapping and update call status.
- **Regression Test:** `apps/api/tests/webhook_crash_recovery.test.ts` (5 tests covering atomic rollback, effect recovery, cold-restart hydration, concurrent deliveries, and media authorization gating).
- **Residual Risk:** None.

---

### Finding BILL-01 (High): Completed Call with Orphaned Wallet Reservation under Crash/Restart
- **Component:** `apps/api/src/modules/telephony/telephony.service.ts` & `apps/api/src/modules/wallets/wallet.service.ts`
- **Reliability Invariant:** A call that terminates in the database must never leave its financial credit reservation permanently locked in `HELD` status. If a process crashes after a database commit but before runtime or wallet settlement, or if a webhook disconnect arrives when no session is in RAM, financial effects must be reconcilable idempotently without double charging, double releasing, or generating duplicate ledger entries.
- **Root Cause:**
  1. The database transaction in `TelephonyService.handleWebhook` was limited to inserting `CarrierWebhookEvent` and updating `Call.status`.
  2. Runtime lifecycle handling (`gateway.handleWebhook`) and wallet settlement (`walletService.settleCall` / `releaseReservation`) were executed strictly outside this database transaction.
  3. In normal operation, wallet settlement occurred when an in-memory `CallSession` ended. However, if the server process crashed, restarted, or if a carrier webhook arrived after memory loss, `syncCallStatus` updated `Call.status = 'COMPLETED'` in PostgreSQL, but no active in-memory session was present to trigger wallet settlement.
  4. As a result, the user's `WalletReservation` remained in `HELD` state indefinitely, permanently trapping user credits.
- **Reproduction:** Created an active call with a `HELD` credit reservation of 10.0 credits. Simulated a process crash by unmounting all in-memory sessions (cold state). Sent a `call.disconnected` webhook with duration = 35 seconds. `Call.status` was updated to `COMPLETED`, but `WalletReservation.status` remained `HELD` with `settledAmount = null` and no ledger entry was created.
- **Fix Applied:**
  1. **Webhook Immediate Financial Reconciliation:** Injected `WalletService` into `TelephonyService` and added `reconcileCallReservation(callId)` to Step 5 of `handleWebhook` (executing both on initial `call.disconnected`/`call.failed` events and on duplicate retries). If the call reached a terminal status without an in-memory session to settle it, `reconcileCallReservation` settles or releases the hold immediately.
  2. **Durable Sweeper Reconciliation:** Implemented `reconcileTerminalCallReservations(limit = 50)` on `WalletService`. It queries for any orphaned `HELD` reservations where the underlying `Call` has transitioned to `COMPLETED`, `FAILED`, or `REJECTED`, settling completed calls (with duration) and releasing holds for failed/unanswered calls.
  3. **Row-Level Concurrency Control:** Both methods leverage existing `SELECT ... FOR UPDATE` row locks inside `WalletService.settleCall` and `WalletService.releaseReservation`, ensuring concurrent workers or repeated recovery attempts serialize safely without duplicate charges or conflicting transactions.
  4. **Type-Safe UUID Filtering:** Filtered candidate `res.callId` strings with a UUID regex prior to querying `prisma.call.findUnique`, preventing Prisma driver errors on legacy non-UUID reservation records.
- **Regression Test:** `apps/api/tests/durable_effects_and_billing_recovery.test.ts` (5 tests covering cold-restart reconciliation, idempotent settlement retries, concurrent settlement vs release serialization, retry after process restart, and concurrent recovery worker execution).
- **Residual Risk:** None.

---

### Finding BILL-02 (High): Recovery Worker Queue Starvation, Missing Terminal Statuses & Orphaned Holds
- **Component:** `apps/api/src/modules/wallets/wallet.service.ts` (`reconcileTerminalCallReservations`) & `apps/api/src/modules/telephony/telephony.service.ts` (`reconcileCallReservation`)
- **Reliability Invariant:** Recovery workers must deterministically process pending terminal reservations in FIFO order without starving older records. Non-completed terminal call statuses (`BUSY`, `NO_ANSWER`) must release holds rather than remain trapped in `HELD`. Calls with 0 duration, missing timestamps, or reversed timestamps (`endedAt < startedAt`) must never be charged billable blocks.
- **Root Cause:**
  1. `reconcileTerminalCallReservations` queried `wallet_reservations` by `status: 'HELD'` without joining or filtering by `Call.status` in SQL, and lacked `orderBy: { createdAt: 'asc' }`. As a result, active calls or skipped non-terminal holds at the front of the query consumed the `limit` window and starved valid terminal calls.
  2. Terminal status checks only handled `COMPLETED`, `FAILED`, and `REJECTED`, omitting `BUSY` and `NO_ANSWER`. Calls ending in `NO_ANSWER` or `BUSY` were never released by the sweeper.
  3. `reconcileCallReservation` fell back to `1` second billable duration (`durationSeconds: call.durationSeconds > 0 ? call.durationSeconds : 1`) whenever `startedAt` was non-null, even if `durationSeconds` was 0 or timestamps were reversed, incorrectly charging non-billable calls.
  4. Orphaned reservations where no underlying `Call` record existed (or with legacy non-UUID callIds) were permanently skipped via `continue`, trapping user funds indefinitely.
- **Reproduction:** Created 3 terminal calls with held reservations. Without FIFO ordering, older records were starved when `limit = 1`. Injected a reversed timestamp call (`endedAt < startedAt`), which was charged 1 second (30s billing block). Injected an expired orphaned reservation with no `Call` record, which remained `HELD` indefinitely.
- **Fix Applied:**
  1. Replaced the unindexed application-level filter with an optimized raw SQL query that joins `calls c` and filters `c.status::text IN ('COMPLETED', 'FAILED', 'REJECTED', 'BUSY', 'NO_ANSWER') OR (c.id IS NULL AND wr.expires_at < NOW())`.
  2. Enforced strict FIFO ordering (`ORDER BY wr.created_at ASC LIMIT ${limit}`) so oldest pending terminal reservations are guaranteed to be processed first.
  3. Added timestamp validation: duration is computed only when `durationSeconds > 0` or `endedAt > startedAt`. Calls with 0 duration, missing timestamps, or reversed timestamps are released via `releaseReservation` with 0 charge.
  4. Expired orphaned reservations with missing `Call` records are automatically released back to the wallet's available balance upon expiry.
- **Regression Test:** `apps/api/tests/financial_invariants_and_recovery_hardening.test.ts` (covers FIFO queue order, orphan release, timestamp validation, non-billable release, and multi-worker execution).
- **Residual Risk:** None.

---

### Finding SEC-08 (Medium): Webhook Event ID Reuse with Conflicting Payload Hash
- **Component:** `apps/api/src/modules/telephony/telephony.service.ts` (`handleWebhook`) & `apps/api/src/modules/telephony/telephony.routes.ts`
- **Security Invariant:** When an incoming webhook carries an `eventId` that was previously claimed, the system must verify that the incoming payload hash matches the original event. Reusing an existing `eventId` with a conflicting or forged payload must be detected and rejected with HTTP 409 Conflict.
- **Root Cause:** In `handleWebhook`, when `prisma.carrierWebhookEvent.create` threw `P2002` (unique constraint on `event_id`), the catch block set `isDuplicate = true` without comparing `rawHash` against the stored `payloadHash`. A tampered or conflicting payload reusing a valid event ID was treated as an authentic duplicate.
- **Reproduction:** Delivered an initial webhook with `eventId = 'evt-tamper-1'`. Delivered a second webhook with the same `eventId` but with a completely different event type (`call.disconnected`) and body. The handler accepted the event with `duplicate: true` instead of rejecting it.
- **Fix Applied:**
  1. In the `P2002` catch block, queried `prisma.carrierWebhookEvent.findUnique({ where: { eventId } })` and compared `existingEvent.payloadHash` against `rawHash`.
  2. If the hashes differ, threw `TelephonyError("Webhook event ID '...' reused with conflicting payload hash", 'WEBHOOK_PAYLOAD_CONFLICT')`.
  3. In `telephony.routes.ts`, mapped `WEBHOOK_PAYLOAD_CONFLICT` to HTTP 409 Conflict.
- **Regression Test:** `apps/api/tests/financial_invariants_and_recovery_hardening.test.ts` (`Detects and rejects reuse of the same event ID with a conflicting payload hash`).
- **Residual Risk:** None.

---

### Finding TEST-01 (Low): Vitest Parallelism & Shared Database Concurrency Race
- **Component:** `apps/api/vitest.config.ts` & `apps/api/src/modules/wallets/wallet.service.ts` (`reconcileTerminalCallReservations`)
- **Reliability Invariant:** Test suites and recovery sweepers running against a shared PostgreSQL database must execute deterministically without race conditions where worker threads in one test file intercept reservations created by another.
- **Root Cause:** Vitest defaults to running test files in parallel (`fileParallelism: true`). When multiple test files concurrently populated and drained global database tables (`wallet_reservations`, `calls`), global sweeper calls in `durable_effects_and_billing_recovery.test.ts` scooped up pending terminal reservations created by `financial_invariants_and_recovery_hardening.test.ts`. Furthermore, `reconcileTerminalCallReservations` lacked tenant-scoping parameters to restrict execution to a single tenant.
- **Reproduction:** Running `npm test` across all 12 test files concurrently caused `Processes reservations in FIFO order` to fail because another test's concurrent sweeper execution drained or interleaved with the local test queue.
- **Fix Applied:**
  1. Configured `fileParallelism: false` in `apps/api/vitest.config.ts`, ensuring deterministic sequential file execution against the shared PostgreSQL test database.
  2. Extended `reconcileTerminalCallReservations(limit = 50, organizationId?: string)` to accept an optional `organizationId` parameter with raw SQL condition interpolation (`AND w.organization_id = ${organizationId}::uuid`), enabling isolated tenant sweeps both in multi-tenant production and test suites.
- **Regression Test:** `apps/api/tests/release_readiness_audit_phase_4_1_4.test.ts` (17 tests) & `apps/api/tests/financial_invariants_and_recovery_hardening.test.ts` (13 tests).
- **Residual Risk:** None.

---

### Finding BILL-03 / ARCH-02 (Low / Architecture): Balance Exhaustion, Durable Debt Representation & Top-up Limitation
- **Component:** `apps/api/src/modules/wallets/wallet.service.ts` (`settleCall` & `topUpWallet`)
- **Financial Invariant:** When a call exceeds the customer's available balance, the platform must never record negative wallet balances, must cap debits at available credits, and must durably preserve the unpaid provider cost in database records.
- **Accounting Analysis:**
  1. In `settleCall`, if `chargeAmount > currentBalance`, `actualCharge = Math.max(0, currentBalance)`, `newBalance = 0.0`, and `unpaidAmount = chargeAmount - actualCharge`.
  2. `wallet_reservations.unpaid_amount` durably preserves this deficit for carrier cost reporting and auditing.
  3. `credit_transactions` records the partial debit with `balance_after = 0.0` and a descriptive audit note (`Unpaid provider cost: ₹...`).
  4. **Limitation Identified:** Auris currently operates a strict prepaid model without automatic negative balance or automated debt collection. When an organization tops up via `topUpWallet`, the top-up amount is credited directly without deducting previously accrued `unpaid_amount` from past calls.
- **Reproduction:** Created a wallet with 10.0 credits. Executed a 300-second call (30.0 credits). Verified that `actualCharge = 10.0`, `unpaidAmount = 20.0`, and `newBalance = 0.0`. Topped up wallet by 50.0 credits; balance became 50.0 rather than 30.0 (unpaid debt is not automatically clawed back).
- **Architecture Recommendation:** For post-paid or hybrid enterprise billing in future phases, implement an optional `autoDeductUnpaidDebt: boolean` on `topUpWallet` to reconcile accumulated `unpaid_amount` against new deposits.
- **Regression Test:** `apps/api/tests/release_readiness_audit_phase_4_1_4.test.ts` (`Settlement exceeding available balance caps at balance, records unpaid debt durably, and documents debt collection limitation`).
- **Residual Risk:** Documented as an intended prepaid architectural property.

---

### Finding SEC-01 (High): Cross-Tenant Call ID Spoofing in `TelephonyGateway.handleWebhook`
- **Component:** `packages/runtime/src/telephony/TelephonyGateway.ts` (lines 135–158)
- **Security Invariant:** Telephony gateway must route webhook events solely based on server-verified `providerCallReference` mappings, never trusting arbitrary `callId` parameters in untrusted incoming payloads.
- **Root Cause:** When `providerCallMap` contained a trusted mapping for `providerCallReference`, but `normalized.callId` was present in the webhook payload, the code used `const callId = normalized.callId || trustedCallId`. An attacker could forge a webhook containing another tenant's `callId` and route events to it.
- **Reproduction:** Call registered with `providerCallReference = 'carrier-call-1'` mapped to `call-tenant-a`. Attacker sent webhook with `carrierCallId: 'carrier-call-1'` and `callId: 'call-tenant-b'`. The event dispatched to `call-tenant-b`.
- **Fix Applied:** Enforced server-side authority: `trustedCallId` takes strict precedence. If `normalized.callId` is provided and conflicts with `trustedCallId`, the gateway immediately rejects the event with `TelephonyError('CROSS_TENANT_CALL_MISMATCH')`.
- **Regression Test:** `packages/runtime/tests/telephony_audit.test.ts` (`SEC-01: strictly prevents cross-tenant callId spoofing in handleWebhook`).
- **Residual Risk:** None in tested single-tenant/multi-tenant mock environment.

---

### Finding SEC-03 (High): Orphaned Socket Leak & Superseded Connection Cleanup
- **Component:** `packages/runtime/src/telephony/MediaStreamSession.ts` (lines 80–115)
- **Security Invariant:** Attaching a new WebSocket to an existing `MediaStreamSession` must cleanly terminate the previous connection and purge all event listeners to prevent split-brain audio routing or memory leaks.
- **Root Cause:** `attachWebSocket(ws)` reassigned `this.ws = ws` without closing the old socket or removing listeners (`message`, `close`, `error`). The old socket remained open and could continue receiving unauthenticated frames.
- **Reproduction:** Invoked `session.attachWebSocket(ws1)`, then `session.attachWebSocket(ws2)`. `ws1` remained in state `OPEN` with active event listeners.
- **Fix Applied:** Added supersede cleanup: `this.ws.close(1000, 'SUPERSEDED_BY_NEW_CONNECTION')`, unhooked all existing event listeners, and replaced them with listeners bound to the new socket.
- **Regression Test:** `packages/runtime/tests/telephony_audit.test.ts` (`SEC-03: cleans up and closes superseded WebSocket connection when reattached`).
- **Residual Risk:** None.

---

### Finding SEC-04 (Medium): Terminal Call WebSocket Connection Rejection & Media Gating
- **Component:** `apps/api/src/modules/telephony/telephony.service.ts` (lines 240–265) & `packages/runtime/src/telephony/MediaStreamSession.ts`
- **Security Invariant:** Stream tokens issued for a call that subsequently terminated in the database must not be allowed to open a media stream session or exchange audio frames. Media transmission must be strictly gated until authorization is complete.
- **Root Cause:** `handleWebSocketConnection` verified token cryptography and claimed nonces, but did not check database call status (`COMPLETED`, `FAILED`, `REJECTED`) before admitting the stream connection and hooking audio frames.
- **Reproduction:** Issued stream token while call was `INITIATED`. Updated call status to `COMPLETED` in database. Client connected with stream token and remained open.
- **Fix Applied:**
  1. Added database call verification in `TelephonyService.handleWebSocketConnection`. If `call.status` is terminal or call is missing, the gateway closes the connection with code `1008 (Policy Violation)` and purges the connection.
  2. Added authorization gating in `MediaStreamSession`: `isAuthorized = false` during the database verification window. Inbound and outbound frames are discarded until `connection.authorize()` is explicitly called upon successful database verification.
- **Regression Tests:**
  - `apps/api/tests/telephony_audit_and_concurrency.test.ts` (`SEC-04: strictly rejects incoming WebSocket stream connection when Call is already in a terminal state`).
  - `apps/api/tests/webhook_crash_recovery.test.ts` (`5. WebSocket Media Gating: Strict rejection of media on unauthorized or terminal call before audio processing`).
- **Residual Risk:** None.

---

### Finding REL-01 (Medium): Unbounded Socket Write Buffering & Slow Consumer Backpressure
- **Component:** `packages/runtime/src/telephony/MediaStreamSession.ts` (lines 160–180)
- **Reliability Invariant:** Outbound media queue accounting must include data buffered in the underlying transport socket (`ws.bufferedAmount`) to prevent slow or stalled consumers from exhausting server memory.
- **Root Cause:** `sendAudioFrame` only checked internal queue buffer (`this.outboundQueuedBytes`), ignoring `(this.ws as any)?.bufferedAmount`. A slow client reading slower than frame delivery could accumulate unbounded socket buffers without tripping `QueueOverflowError`.
- **Reproduction:** Mocked `ws.bufferedAmount = 65536`. Enqueued frames with `maxQueuedBytes = 64000`. Frame was accepted instead of throwing `QueueOverflowError`.
- **Fix Applied:** Updated queue check: `const socketBufferedBytes = (this.ws as any)?.bufferedAmount || 0; if (this.outboundQueuedBytes + socketBufferedBytes + frame.payloadBytes.length > this.config.maxQueuedBytes) throw new QueueOverflowError(...)`.
- **Regression Test:** `packages/runtime/tests/telephony_audit.test.ts` (`REL-01: accounts for ws.bufferedAmount in outbound queue overflow checks`).
- **Residual Risk:** None.

---

### Finding SEC-05 (Low): Insecure Default Host Binding (`0.0.0.0`)
- **Component:** `apps/api/src/config.ts` & `apps/api/src/server.ts`
- **Security Invariant:** In local development and mock-first evaluation, services must bind strictly to the loopback interface (`127.0.0.1`) to prevent accidental LAN exposure.
- **Root Cause:** Fastify server listened without explicit host or defaulted to `0.0.0.0`, exposing the API and WebSocket streaming gateway to the local network.
- **Fix Applied:** Added `HOST: z.string().default('127.0.0.1')` in `config.ts` and passed `{ port: config.PORT, host: config.HOST }` to `server.listen`.
- **Regression Test:** Verified via server startup options and audit tests binding to `127.0.0.1`.
- **Residual Risk:** None.

---

### Finding SEC-06 (Low): Asymmetric Webhook Timestamp Drift Tolerance
- **Component:** `packages/runtime/src/telephony/MockWebhookSignatureVerifier.ts` (lines 92–98)
- **Security Invariant:** Future timestamps should not be accepted beyond acceptable clock skew (max 15s), preventing attackers from pre-generating valid signatures far into the future.
- **Root Cause:** Timestamp validation used symmetric `Math.abs(nowSec - timestamp) > this.toleranceSeconds (300s)`, allowing signatures dated up to 5 minutes in the future.
- **Fix Applied:** Constrained future drift: `timestamp < nowSec - this.toleranceSeconds || timestamp > nowSec + 15`. Signatures >15s in the future are rejected with `EXPIRED_TIMESTAMP`.
- **Regression Test:** `packages/runtime/tests/telephony_audit.test.ts` (`SEC-06: rejects future timestamps exceeding 15 seconds clock skew`).
- **Residual Risk:** None.

---

### Finding SEC-07 (Low): Non-Strict Webhook Signature Hex Validation
- **Component:** `packages/runtime/src/telephony/MockWebhookSignatureVerifier.ts` (lines 80–86)
- **Security Invariant:** Webhook signatures must be validated for exact 64-character hexadecimal encoding before buffer conversion or cryptographic comparison.
- **Root Cause:** Verifier accepted any string for `v1=...`, passing arbitrary hex strings to `Buffer.from(signatureHex, 'hex')`.
- **Fix Applied:** Added regex check: `/^[0-9a-f]{64}$/i.test(signatureHex)`. Non-matching signatures fail immediately with `MALFORMED_HEADER`.
- **Regression Test:** `packages/runtime/tests/telephony_audit.test.ts` (`SEC-07: strictly enforces 64-character hex format for SHA-256 signatures`).
- **Residual Risk:** None.

---

### Finding ARCH-01 (Informational): Single-Instance Scope of Stream Token Nonces
- **Component:** `packages/runtime/src/telephony/StreamTokenManager.ts`
- **Invariant:** Stream tokens must be strictly single-use.
- **Observation:** `StreamTokenManager` uses an in-memory `Map<string, number>` for single-use nonce tracking. In a single-process deployment, concurrent barrier testing proves that exactly 1 connection consumes the token and simultaneous requests fail. Across multiple independent server processes or worker clusters, an external distributed lock/datastore (e.g. Redis or database transactional nonce table) would be required to prevent cross-node replay.
- **Action Taken:** Verified atomic single-use safety in the single-process development environment. Formally documented this distributed scaling requirement as a pre-production deployment prerequisite.

---

## D. SECURITY CONCLUSIONS

1. **WebSocket Authentication & Access Control:**
   - Stream tokens are cryptographically signed (HMAC-SHA256) with short expiry (60s).
   - Validation occurs before call media attachment. Invalid, tampered, expired, or cross-tenant tokens are rejected with WebSocket close code `1008 (Policy Violation)`.
   - Connections attempting to attach to a call that is already terminal (`COMPLETED`, `FAILED`, `REJECTED`) are rejected with close code `1008`.
   - Media transmission is gated behind `isAuthorized`: audio frames cannot be sent or received until database status verification completes.

2. **Atomic Single-Use Token Enforcement:**
   - Nonces are generated with cryptographically secure randomness (`crypto.randomBytes(16)`).
   - Atomic consumption via `claimedNonces.has(nonce)` ensures that under concurrent connection attempts (tested with 5 simultaneous requests via `Promise.all`), exactly 1 connection succeeds and all other 4 attempts are rejected with `StreamTokenReusedError`.

3. **Webhook Raw-Body HMAC-SHA256 Verification:**
   - Raw HTTP bytes are preserved via `@fastify/raw-body` without JSON parsing or reserialization.
   - Canonical format `v1:${timestamp}:${rawBody}` is verified with `crypto.timingSafeEqual`.
   - Malformed signatures, tampered bodies, and timestamps >15s in the future or >300s in the past are rejected.

4. **Replay Protection vs Durable Event Deduplication:**
   - Signature replay is stopped at the HTTP layer via `MockWebhookSignatureVerifier.replayCache` returning `409 Conflict`.
   - Event delivery deduplication is durably enforced in PostgreSQL via `CarrierWebhookEvent` table (`P2002` unique constraint on `eventId`).
   - Atomic database transactions ensure that `CarrierWebhookEvent` insertion and `Call` status update commit together. If call state update fails, the event insertion rolls back.
   - On retry, idempotent recovery guarantees that any uncompleted call transitions converge without duplicating completed side effects.

5. **Multi-Tenant Isolation:**
   - Organization identity is derived from authenticated JWT claims.
   - Users cannot issue stream tokens for calls belonging to other organizations (returns `400/403/404`).
   - Presenting a token issued for Org B to attach to Call A results in immediate rejection (`code 1008`).

6. **Local-Only Exposure:**
   - Fastify binds explicitly to `127.0.0.1`.
   - No external ports or public network listeners are exposed.

---

## E. RELIABILITY CONCLUSIONS

1. **Queue Bounds & Memory Safety:**
   - Media frames strictly adhere to 20ms mono 16kHz 16-bit linear PCM (640 bytes raw audio).
   - Inbound and outbound queues enforce frame count and byte count limits.
   - Transport backpressure monitors `(this.ws as any)?.bufferedAmount` and raises `QueueOverflowError` when limits are exceeded.

2. **Barge-In & Audio Cancellation:**
   - When user speech is detected during agent speech playback, `MediaStreamSession.clearBuffer()` flushes internal queues and transmits an explicit `{ event: 'clear', streamId }` control frame to the client.
   - Stale audio output is prevented from playing out.

3. **Call Lifecycle & Billing Concurrency:**
   - Tested race conditions between simultaneous carrier webhook disconnects and client WebSocket closures.
   - Database call status transitions idempotently to `COMPLETED` without duplicate settlements, duplicate balance deductions, or ledger anomalies.

4. **Resource Cleanup:**
   - Superseded WebSockets are closed and unhooked.
   - Disposed sessions clear timers, abort controllers, queues, and event listeners.

5. **Crash Recovery & Process Restart Hydration:**
   - Process restart memory loss does not lose webhook mapping: `TelephonyService` automatically queries PostgreSQL (`calls.carrier_call_id`) and re-populates the gateway mapping.
   - Retried events converge safely to their terminal status without duplicating financial holds or ledger entries.

6. **Transaction Boundaries & Financial Reconciliation Architecture (Phase 4.1.2 Audit):**
   - **Inside DB Transaction (`prisma.$transaction`):**
     - Atomically claims the unique event via `CarrierWebhookEvent.create({ eventId, ... })`.
     - Atomically updates `Call` record (`status`, `startedAt`, `endedAt`, `terminationReason`).
     - If either operation throws, the entire transaction rolls back cleanly, leaving no orphaned event records.
   - **Outside DB Transaction:**
     - In-memory `CallSession` state transitions and event emitter dispatches.
     - WebSocket audio socket teardown and streaming STT abort controllers.
     - Financial operations (`WalletService.settleCall`, `WalletService.releaseReservation`).
   - **Guarantees vs Non-Guarantees (No Exactly-Once Processing Claims):**
     - **Transactionally Atomic:** `CarrierWebhookEvent` record insertion + `Call.status` convergence.
     - **Idempotent Under Retry:** Call status convergence (`COMPLETED` remains `COMPLETED`), wallet settlement (via `idempotencyKey` and `ALREADY_SETTLED` checks returning existing transaction), wallet release (safe no-op if already cancelled), and webhook acknowledgment (returns `duplicate: true`, HTTP 200).
     - **Recoverable After Process Restart:** Carrier call mappings re-hydrate from database `@unique carrier_call_id`, orphaned `HELD` reservations are recovered via `reconcileTerminalCallReservations` sweeper and webhook Step 5 `reconcileCallReservation`.
     - **NOT Recoverable After Process Restart:** Ephemeral in-memory audio buffers, active streaming STT connections, and in-flight LLM voice turns. A process crash severing the media socket permanently interrupts conversation audio; the platform guarantees financial and database consistency, not live conversational socket resuscitation.

8. **Financial Invariants (Phase 4.1.3 Audit):**
   - **Invariant 1 & 4 (Single Settlement & No Double Debit):** A reservation produces at most one successful settlement. Repeated or concurrent settlement attempts detect `status: 'ALREADY_SETTLED'` and return the existing record without debiting the wallet balance twice.
   - **Invariant 2 & 5 (Settle vs Release Mutual Exclusion):** A reservation cannot be both settled and released. Attempting to settle a cancelled reservation throws `RESERVATION_ALREADY_CANCELLED`; attempting to cancel a settled reservation throws `CANNOT_CANCEL_SETTLED_RESERVATION`. Repeated releases detect `status: 'ALREADY_CANCELLED'` without releasing funds twice.
   - **Invariant 3 & 7 (No Phantom Success & Ledger Integrity):** Failed settlements throw an error and roll back entirely. Every successful balance debit has an atomically created `CreditTransaction` record.
   - **Invariant 6 (Concurrency Serialization):** Concurrent settlement and release serialize via PostgreSQL row-level `SELECT ... FOR UPDATE` locks. Exactly one operation succeeds; the other yields or receives `ALREADY_SETTLED` / `ALREADY_CANCELLED`.
   - **Invariant 8 (Overdraft Invariant):** When a call duration exceeds reserved credits or available balance, deduction is capped at available balance (`Math.max(0, currentBalance)`), recording unpaid debt transparently without allowing negative balances.
   - **Invariant 9 & 10 (Recovery Safe Billing):** Recovery sweeper never bills non-billable, unanswered, busy, or failed calls (`NO_ANSWER`, `BUSY`, `FAILED`, `REJECTED`); their credit holds are released with 0 charge.
   - **Invariant 11 & 12 (Timestamp Integrity & Documented 30s Block):** Billable duration enforces 30s unit ceiling (`Math.ceil(duration / 30) * 30`). Calls with missing, 0, or reversed timestamps (`endedAt < startedAt`) yield 0 billable duration and are released without charge.

9. **Recovery Worker & Webhook Idempotency Hardening (Phase 4.1.3 Audit):**
   - **SQL Selection Filter:** Replaced unindexed table scan with an inner raw SQL join: `JOIN calls c ON c.id::text = wr.call_id WHERE wr.status = 'HELD' AND (c.status::text IN ('COMPLETED', 'FAILED', 'REJECTED', 'BUSY', 'NO_ANSWER') OR (c.id IS NULL AND wr.expires_at < NOW()))`.
   - **Starvation Elimination:** Enforced deterministic FIFO ordering (`ORDER BY wr.created_at ASC LIMIT ${limit}`) so older pending terminal records are never starved by active or skipped rows.
   - **Orphan Hold Release:** Expired reservations with no corresponding `Call` record are released back to the wallet's available balance upon expiry, preventing permanently trapped credits.
   - **Webhook Payload Conflict Quarantine:** When `P2002` duplicate event ID is caught, `existingEvent.payloadHash` is compared against incoming `rawHash`. If payload hashes differ, the request is rejected with `WEBHOOK_PAYLOAD_CONFLICT` (HTTP 409 Conflict).
   - **Terminal Call Revival Protection:** Retried or out-of-order `call.answered` events are strictly prevented from reviving calls in terminal states (`COMPLETED`, `FAILED`, `REJECTED`, `BUSY`, `NO_ANSWER`).

---

## F. TEST EXECUTION & EVIDENCE

### Baseline Results
- Command: `npm test`
- Exit Code: 0
- Tests Executed: 167 (43 in `@auris/runtime`, 124 in `@auris/api`)
- Passed: 167, Failed: 0, Skipped: 0

### Phase 4.1.3 Focused Test Results
- **Command:** `npx vitest run tests/financial_invariants_and_recovery_hardening.test.ts` (in `apps/api`)
- **Exit Code:** **0**
- **Test File:** `tests/financial_invariants_and_recovery_hardening.test.ts` (13 tests, 702ms)
  - `Invariant 1 & 4: A reservation produces at most one successful settlement; repeated attempts do not double deduct`
  - `Invariant 2 & 5: A reservation cannot be both settled and released; repeated releases do not double refund`
  - `Invariant 3 & 7: Failed settlement cannot be reported as successful; every debit has durable ledger record`
  - `Invariant 6: Concurrent settlement and release cannot both apply conflicting financial effects`
  - `Invariant 8: Balance, reservation status, and ledger remain consistent under overdraft capping`
  - `Invariant 10, 11 & 12: Recovery never bills non-billable calls, uses 30s block rounding, and handles reversed timestamps cleanly`
  - `Rolls back cleanly if database transaction throws during settlement`
  - `Recovers terminal call with outstanding reservation after cold in-memory restart`
  - `Detects and rejects reuse of the same event ID with a conflicting payload hash`
  - `Retried or out-of-order webhook events do not revive terminal calls`
  - `Processes reservations in FIFO order (createdAt: asc) avoiding starvation`
  - `Safely releases expired orphaned reservations with no underlying Call record`
  - `Multiple concurrent recovery workers process pending effects safely without duplicate charges`

### Phase 4.1.4 Release Readiness & Independent Verification Results
- **Command:** `npx vitest run tests/release_readiness_audit_phase_4_1_4.test.ts` (in `apps/api`)
- **Exit Code:** **0**
- **Test File:** `tests/release_readiness_audit_phase_4_1_4.test.ts` (17 tests, 1111ms)
  - `Zero balance wallet rejects reservation creation with INSUFFICIENT_FUNDS`
  - `Mid-call extension returns TERMINATE_CALL when available funds are insufficient`
  - `Settlement exceeding available balance caps at balance, records unpaid debt durably, and documents debt collection limitation`
  - `Database error during settlement transaction rolls back wallet, reservation, and ledger atomically`
  - `Duplicate settlement and duplicate release are strictly idempotent with no multiple charges or refunds`
  - `Accepts duplicate event with identical payload, but rejects reuse with conflicting payload (409 Conflict)`
  - `Concurrent duplicate webhook deliveries produce exactly 1 database event and 1 call state update`
  - `Out-of-order answered webhook does not revive an already COMPLETED call`
  - `Strictly rejects invalid signatures, expired timestamps, and future timestamp tampering`
  - `Cross-tenant call ID spoofing in webhook payload is strictly rejected`
  - `Recovery processes batches in strict FIFO order without starving older records when limit < queue size`
  - `Expired orphaned reservations with no underlying Call record are safely released without errors`
  - `Never bills calls with missing, zero, or reversed timestamps`
  - `Four concurrent recovery workers process pending calls without double-charges or deadlocks`
  - `Failed worker records remain retryable on subsequent runs`
  - `Proves that omitting payload hash comparison would falsely accept forged webhooks`
  - `Proves that timestamp ordering in PostgreSQL query is what guarantees FIFO execution`

### Final Post-Remediation Results
- **Command 1: `npm test` (root workspace)**
  - Exit Code: **0**
  - **`@auris/runtime`:** 3 test files, **51 passed**, 0 failed
    - `tests/telephony_audit.test.ts` (8 tests)
    - `tests/telephony_contracts.test.ts` (30 tests)
    - `tests/runtime_voice_lifecycle.test.ts` (13 tests)
  - **`@auris/api`:** 13 test files, **169 passed**, 0 failed
    - `tests/release_readiness_audit_phase_4_1_4.test.ts` (17 tests)
    - `tests/financial_invariants_and_recovery_hardening.test.ts` (13 tests)
    - `tests/durable_effects_and_billing_recovery.test.ts` (5 tests)
    - `tests/webhook_crash_recovery.test.ts` (5 tests)
    - `tests/telephony_audit_and_concurrency.test.ts` (5 tests)
    - `tests/runtime_integration.test.ts` (6 tests)
    - `tests/agent_management.test.ts` (5 tests)
    - `tests/telephony_gateway.test.ts` (16 tests)
    - `tests/frontend_api_integration.test.ts` (19 tests)
    - `tests/billing_and_tenancy.test.ts` (11 tests)
    - `tests/runtime_concurrency_and_recovery.test.ts` (35 tests)
    - `tests/auth_and_security.test.ts` (10 tests)
    - `tests/authorization_and_wallet_integrity.test.ts` (22 tests)
  - **Total Tests Passed:** **220**
  - **Total Tests Failed:** **0**

- **Command 2: `npm run build` (root workspace)**
  - Exit Code: **0**
  - `@auris/database`: `tsc` -> Clean build (exit code 0)
  - `@auris/runtime`: `tsc` -> Clean build (exit code 0)
  - `@auris/api`: `tsc` -> Clean build (exit code 0)
  - `@auris/web`: `next build` -> Clean build, static pages generated successfully (exit code 0)

---

## G. LIMITATIONS

1. **Local-Only Mock Telephony:** Tested strictly against the local mock telephony provider and mock media streams. Real carrier protocol nuances (Twilio TwiML / Plivo XML / carrier SIP gateways) were not tested and must not be used until authorized.
2. **Distinction Between Process Restart and In-Memory Continuity:** Cold process restarts clear in-memory Maps and sessions. Database hydration successfully recovers carrier mappings (`carrier_call_id`) and resolves orphaned financial reservations. However, active conversation turns, audio buffers, and live WebSocket connections cannot be reconstructed after process termination without re-establishing client transport.
3. **Recovery Worker Scheduling Limitation:** In the current architecture, `reconcileTerminalCallReservations` is executed programmatically or upon webhook disconnect/failure events. There is no active standalone background cron process running by default in the local development environment; production deployment will require a scheduled task runner (e.g. pg_cron, BullMQ, or Kubernetes CronJob) to periodically invoke the sweeper.
4. **Simulated Partial Failures vs Hard OS Kill:** Partial failures were validated via injected exceptions, detached runtime sessions, aborted connections, and rolled-back database transactions. Hard OS-level `SIGKILL` tests were avoided to protect local background tooling.
5. **Single-Process Nonce Scope:** Stream token single-use nonce tracking is held in local process memory (`Map`). Distributed deployments across multiple server containers will require external atomic nonce persistence (e.g., Redis or transactional database table).
6. **Prepaid Balance Exhaustion & Debt Collection Limitation:** When a call's duration exceeds the customer's wallet balance, debits are capped at the remaining balance (preventing negative balances), and the provider cost deficit is durably preserved in `wallet_reservations.unpaid_amount`. However, subsequent wallet top-ups do not automatically deduct previously accumulated unpaid debts; automatic debt clawback must be implemented if post-paid / hybrid billing is required.

---

## H. SAFETY COMPLIANCE STATEMENT

In strict adherence to the safety boundaries defined for Phase 4.1, 4.1.1, 4.1.2 & 4.1.3:
- **No live telephony providers** (Twilio, Plivo, etc.) were contacted or configured.
- **No real telephone calls** were initiated, received, or terminated.
- **No SMS messages** were dispatched.
- **No real credentials** or payment gateways were utilized.
- **No public network deployment**, firewall changes, tunnels (e.g. ngrok), or DNS modifications occurred.
- **No destructive database operations** (resets, drops, or destructive migrations) were executed on PostgreSQL.
- **No Git commits, pushes, or branch operations** were performed.
- All testing was conducted against local mock implementations on loopback `127.0.0.1`.

---

## I. RECOMMENDATIONS & NEXT STEPS

1. **Phase 4.1, 4.1.1, 4.1.2 & 4.1.3 Milestone Status:** **COMPLETE & VERIFIED (PASS WITH LIMITATIONS)**.
2. **Next Safe Milestone:** Proceed to **Phase 4.2: Structured Telephony Carrier Adapters (Mock Sandbox)**.
   - Build formal carrier-specific payload mappers (Twilio Media Streams / Plivo Audio Streams format adapters) strictly using deterministic mock test harnesses.
   - Deploy background worker cron daemon for `reconcileTerminalCallReservations` before production multi-worker deployment.
   - Implement distributed stream token nonce storage abstraction before any multi-instance deployment.
   - Do not connect to real carrier sandboxes or production APIs without explicit user authorization.
