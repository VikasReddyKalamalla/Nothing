# Auris Phase 3.1 — Runtime Reliability Audit & Targeted Remediation Report

**Project:** Auris — The Voice AI Workforce for Every Business  
**Workspace:** `E:\Nothing`  
**Phase:** 3.1 — Runtime Reliability Audit, Billing Concurrency, Crash Recovery & Event Ordering  
**Date:** 2026-10-27  
**Status:** Complete  

---

## A. Executive Verdict

### **Verdict: PASS (Ready for Controlled Phase 4 Telephony Connection Planning)**

The Auris Phase 3 provider-neutral voice runtime and control-plane financial mechanisms have undergone comprehensive concurrency, crash recovery, state transition, and event-ordering stress testing against the live PostgreSQL database. All verified defects were reproduced with regression tests, remedied with minimal surgical fixes, and proven across 112 passed tests (0 regressions, 0 failures) and clean production builds.

---

## B. Baseline and Final Verification

### 1. Baseline Test Execution (Pre-Remediation)
- **Command:** `npm test` (`npm run --workspace=@auris/runtime test && npm run --workspace=@auris/api test`)
- **Exit Code:** `0`
- **Test Files:** 7 test files (1 runtime + 6 api)
- **Test Count:** 86 passed, 0 failed
- **Production Build:** `npm run build` exited with code `0`

### 2. Final Verification (Post-Remediation)
- **Command:** `npm test`
- **Exit Code:** `0`
- **Test Files:** 8 test files across workspace (1 in `@auris/runtime`, 7 in `@auris/api`)
- **Test Count:** **112 passed, 0 failed** (13 runtime unit tests + 99 API/integration tests)
  - `packages/runtime/tests/runtime_voice_lifecycle.test.ts`: 13 passed
  - `apps/api/tests/runtime_concurrency_and_recovery.test.ts`: 26 passed (NEW comprehensive reliability suite)
  - `apps/api/tests/authorization_and_wallet_integrity.test.ts`: 22 passed
  - `apps/api/tests/frontend_api_integration.test.ts`: 19 passed
  - `apps/api/tests/billing_and_tenancy.test.ts`: 11 passed
  - `apps/api/tests/auth_and_security.test.ts`: 10 passed
  - `apps/api/tests/runtime_integration.test.ts`: 6 passed
  - `apps/api/tests/agent_management.test.ts`: 5 passed
- **Production Build:** `npm run build`
  - Exit Code: `0`
  - `@auris/database`: `tsc` compiled clean (0 errors)
  - `@auris/runtime`: `tsc` compiled clean (0 errors)
  - `@auris/api`: `tsc` compiled clean (0 errors)
  - `@auris/web`: `next build` compiled clean (4 static pages generated, 0 type errors)

---

## C. Findings & Targeted Remediation

### Finding 1: Non-Finite & Invalid Duration Arithmetic in `calculateCallCharge`
- **Severity:** Medium
- **Location:** [`apps/api/src/modules/wallets/wallet.service.ts`](file:///e:/Nothing/apps/api/src/modules/wallets/wallet.service.ts#L48-L62) — `WalletService.calculateCallCharge()`
- **Reproduction Steps:** Call `WalletService.calculateCallCharge(NaN, 5.0)` or `WalletService.calculateCallCharge(Infinity, 5.0)`.
- **Observed Behavior:** Returned `{ billableSeconds: NaN, chargeAmount: NaN }`. Passing `NaN` into Prisma or SQL queries causes database transaction failures or arithmetic errors.
- **Expected Behavior:** Non-finite (like `NaN`, `Infinity`, or negative values) should be evaluated safely to `{ billableSeconds: 0, chargeAmount: 0 }`.
- **Root Cause:** Condition `if (durationSeconds <= 0)` fails for `NaN` and `Infinity` because in JavaScript, `NaN <= 0` is `false`.
- **Fix:** Added `!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(ratePerMinute) || ratePerMinute <= 0` guard.
- **Regression Test:** `Phase B6: Billing Arithmetic and Boundary Values > safely handles non-finite, negative, and invalid durations without corrupting calculation` in `apps/api/tests/runtime_concurrency_and_recovery.test.ts`.
- **Residual Risk:** None. Invalid inputs are coerced safely to zero billable seconds.

---

### Finding 2: Unchecked Barge-In / VAD Events Arriving During Terminal States
- **Severity:** High
- **Location:** [`packages/runtime/src/orchestrator/VoiceTurnOrchestrator.ts`](file:///e:/Nothing/packages/runtime/src/orchestrator/VoiceTurnOrchestrator.ts#L74-L85) — `VoiceTurnOrchestrator.handleUserSpeechStart()`
- **Reproduction Steps:** Trigger `orchestrator.handleUserSpeechStart()` when the call state machine has already transitioned to `TERMINATING`, `SETTLING`, `COMPLETED`, or `FAILED`.
- **Observed Behavior:** `handleUserSpeechStart()` attempted `this.stateMachine.transition(CallState.LISTENING, ...)`, throwing `InvalidStateTransitionError: Invalid call state transition from COMPLETED to LISTENING triggered by "USER_BARGE_IN"`.
- **Expected Behavior:** Late VAD or speech start events arriving from carrier audio buffers after termination must be safely ignored.
- **Root Cause:** Unlike `handleUserFinalTranscript()`, `handleUserSpeechStart()` lacked the `if (this.stateMachine.isTerminatingOrDone()) return;` check.
- **Fix:** Added `if (this.stateMachine.isTerminatingOrDone()) return;` at the entry point of `handleUserSpeechStart()`.
- **Regression Test:** `Phase D: State Machine and Event Ordering > D3: barge-in or speech start arriving when call is terminating or completed does not crash or throw` in `apps/api/tests/runtime_concurrency_and_recovery.test.ts`.
- **Residual Risk:** None. Late events from carrier network buffers are discarded safely without mutating state.

---

### Finding 3: Race Condition on Concurrent `CallSession.terminate()` Calls
- **Severity:** High
- **Location:** [`packages/runtime/src/session/CallSession.ts`](file:///e:/Nothing/packages/runtime/src/session/CallSession.ts#L263-L362) — `CallSession.terminate()`
- **Reproduction Steps:** Invoke `session.terminate()` concurrently from multiple asynchronous callers (e.g. carrier disconnect webhook racing a timeout).
- **Observed Behavior:** Multiple callers entered the asynchronous termination routine in parallel before `isTerminal()` was true, executing concurrent calls to `walletBridge.finalizeSettlement()`, `eventLogger.finalizeCallRecord()`, and throwing state transition errors on the second transition attempt.
- **Expected Behavior:** Concurrent calls to `terminate()` must join the same in-flight Promise and execute settlement exactly once.
- **Root Cause:** Asynchronous gap between state check and transition completion allowed re-entry.
- **Fix:** Stored `this.terminationPromise` upon first entry and returned `this.terminationPromise` for all subsequent or concurrent callers.
- **Regression Test:** `Phase D: State Machine and Event Ordering > D4: handles concurrent terminate() calls cleanly without race or state corruption` in `apps/api/tests/runtime_concurrency_and_recovery.test.ts`.
- **Residual Risk:** None. Exactly one settlement and database finalization runs per session.

---

## D. Financial Integrity Matrix

| Test Scenario | Concurrency Level | Expected Outcome | Observed Outcome | Status |
|:---|:---|:---|:---|:---|
| **B1: Concurrent Reservations** | 5 competing requests for ₹10.00 wallet balance (2 x ₹5.00) | Exactly 2 succeed, 3 fail with `INSUFFICIENT_FUNDS`. Reserved = ₹10.00, Available = ₹0.00. | Exactly 2 fulfilled, 3 rejected. Wallet balance reconciles. | **PASS** |
| **B1: Reservation Rollback** | Invalid reservation attempt (negative amount) | Transaction rolls back, 0 hold applied, balance untouched. | Threw `RESERVATION_AMOUNT_MUST_BE_POSITIVE`. Wallet balance & hold untouched. | **PASS** |
| **B2: Concurrent Settlement** | 5 parallel `settleCall()` on same `callId` | Charged exactly once. 1 `SETTLED`, 4 `ALREADY_SETTLED`. Exactly 1 ledger debit. | 1 `SETTLED`, 4 `ALREADY_SETTLED`. Exactly ₹2.50 deducted. | **PASS** |
| **B3: Settle vs Release Race** | Parallel `settleCall()` vs `releaseReservation()` | Exactly 1 terminal state commits. Winner commits, loser rejected with documented error. | Either `SETTLED` (rejecting cancel) or `CANCELLED` (rejecting settle). Zero duplicate operations. | **PASS** |
| **B4: Lease Extension vs Settle Race** | Parallel `extendReservation()` vs `settleCall()` | No held credits stranded. Final reserved credits = ₹0.00 after settlement finishes. | Reserved credits = ₹0.00. Zero credit leakage. | **PASS** |
| **B5: Duplicate Call Identifiers** | Duplicate `createReservation()` with same `callId` | Returns existing reservation idempotently without double-holding. | Returned existing reservation. Held credits = ₹5.00 (single hold). | **PASS** |
| **B6: 30s Billing Boundaries** | 0s, 1s, 29s, 30s, 31s, 59s, 60s, 61s, 89s, 90s, 91s | Exact discrete 30s blocks: 1-30s = 30s, 31-60s = 60s, 61-90s = 90s, 91s = 120s. | All 11 boundary test cases match mathematical expectation exactly. | **PASS** |
| **B6: Invalid/Non-Finite Durations** | `NaN`, `Infinity`, `-10`, `null`, `undefined` | Coerced safely to `{ billableSeconds: 0, chargeAmount: 0 }`. | Zero charges returned, no database corruption. | **PASS** |
| **B7: Reconciliation Invariant** | Post-test oracle across all scenarios | `balance >= 0`, `reserved >= 0`, `sum(HELD) == reservedCredits`. | All 3 invariants verified after every scenario. | **PASS** |

---

## E. State Machine & Event-Ordering Matrix

| Event Sequence | Expected State Trajectory | Actual Outcome | Status |
|:---|:---|:---|:---|
| Normal Outbound Call | `INITIALIZING -> RESERVING -> RINGING -> ACTIVE -> SPEAKING -> LISTENING -> PROCESSING -> SPEAKING -> TERMINATING -> SETTLING -> COMPLETED` | Matches trajectory exactly with timestamps and audit records. | **PASS** |
| Forbidden Transition (`RINGING -> SPEAKING`) | Must throw `InvalidStateTransitionError` | Throws `InvalidStateTransitionError` with source/target metadata. | **PASS** |
| Forbidden Reopening (`COMPLETED -> ACTIVE`) | Must throw `InvalidStateTransitionError` | Throws `InvalidStateTransitionError`. Terminal states are immutable. | **PASS** |
| Duplicate `ringing` events from carrier | Remains in `RINGING` without duplicate handler execution | Safely deduplicated in `CallSession`. | **PASS** |
| Duplicate `connected` events from carrier | Remains in `ACTIVE` without reinitializing orchestrator or double-starting VAD | Deduplicated safely. | **PASS** |
| Late carrier `audioChunk` after `COMPLETED` | Discarded without crash or state reopening | Ignored safely. State remains `COMPLETED`. | **PASS** |
| Late VAD `speechStart` after `COMPLETED` | Discarded without throwing illegal transition | Ignored safely via `isTerminatingOrDone` guard. | **PASS** |
| 4 Concurrent `session.terminate()` calls | Idempotent single execution; returns same promise | All 4 promises resolve to `COMPLETED`. Single settlement committed. | **PASS** |

---

## F. Crash Recovery & Partial Failure

### 1. Verified Recovery Behaviors (Tested with Real PostgreSQL)
- **C1: Crash Before Reservation Commit:** Handled by PostgreSQL transaction rollback (`prisma.$transaction`). No partial hold survives.
- **C2: Orphaned Reservation Recovery (`reconcileExpiredReservations`):**
  - Tested: Created an orphaned hold with an expired `expiresAt` timestamp (simulating worker crash before dialing carrier).
  - Executed `walletService.reconcileExpiredReservations()`.
  - Result: Orphaned hold detected and safely cancelled; held credits returned to available balance; net charge ₹0.00.
- **C5: Crash During Settlement Retry Idempotency:**
  - Tested: Simulated network timeout immediately after settlement committed. Retry call returned `ALREADY_SETTLED` without duplicate deduction.

### 2. Limitations of Single-Node / Mock Architecture
- **In-Memory Audio Buffer & LLM Stream:** If a process crashes mid-sentence, in-memory audio buffers and active WebSocket streams to Plivo/Twilio are lost. No production voice platform resumes active audio in-flight across process death; recovery consists of carrier hangup and safe reservation reconciliation.
- **Distributed Lock Primitives:** Single-instance concurrency relies on PostgreSQL row locks (`SELECT ... FOR UPDATE`). When scaling horizontally to multiple API instances, distributed queue/lease mechanisms (e.g., Redis or database advisory locks) will be required for multi-node worker coordination.

---

## G. Resource & Stress Testing

- **Workload:** 10 rapid sequential session start/run/terminate cycles against the local database and mock adapters.
- **Concurrency:** Up to 5 parallel competing reservation and settlement tasks per call.
- **Observed Behavior:**
  - All 10 rapid session cycles acquired pre-auth holds, answered, ran, and terminated cleanly to `COMPLETED`.
  - All STT streams aborted and released upon call termination.
  - Telephony cleared carrier buffers on hangup.
  - Final wallet reserved balance: exactly `₹0.00` (zero held credits leaked).
  - Event listener count remained stable without memory leak warnings.

---

## H. Files Created or Modified

1. **[`apps/api/src/modules/wallets/wallet.service.ts`](file:///e:/Nothing/apps/api/src/modules/wallets/wallet.service.ts):**
   - *Modified:* Added `Number.isFinite` guard in `calculateCallCharge` to prevent `NaN`/`Infinity` duration corruption.
2. **[`packages/runtime/src/orchestrator/VoiceTurnOrchestrator.ts`](file:///e:/Nothing/packages/runtime/src/orchestrator/VoiceTurnOrchestrator.ts):**
   - *Modified:* Added `if (this.stateMachine.isTerminatingOrDone()) return;` guard to `handleUserSpeechStart()` to ignore late VAD events during call teardown.
3. **[`packages/runtime/src/session/CallSession.ts`](file:///e:/Nothing/packages/runtime/src/session/CallSession.ts):**
   - *Modified:* Added `terminationPromise` lock in `terminate()` to serialize concurrent hangup events into a single execution.
4. **[`apps/api/tests/runtime_concurrency_and_recovery.test.ts`](file:///e:/Nothing/apps/api/tests/runtime_concurrency_and_recovery.test.ts):**
   - *Created:* 26 comprehensive tests covering billing concurrency, crash recovery, state matrix, and multi-tenant isolation.
5. **[`docs/phase-3.1-reliability-audit.md`](file:///e:/Nothing/docs/phase-3.1-reliability-audit.md):**
   - *Created/Updated:* Complete reliability audit and findings documentation.

*All unrelated files, control-plane routes, UI components, and Phase 1/Phase 2 modules were preserved without modification.*

---

## I. Remaining Blockers Before Connecting External Telephony Providers

The following infrastructure items must be addressed before connecting live telephony (Phase 4):

1. **Carrier Webhook Authentication & Signature Verification:**
   - Plivo/Twilio webhooks must validate carrier HMAC signatures (`X-Plivo-Signature` or `X-Twilio-Signature`) to prevent forged call events.
2. **Bidirectional Carrier WebSocket Stream:**
   - Implement real audio transcoding (`audio/x-mulaw` 8kHz or `audio/l16` 16kHz PCM) between carrier media streams and streaming STT/TTS providers.
3. **Multi-Node Distributed Session Routing:**
   - If running multiple runtime instances, incoming carrier webhooks for a specific `carrierCallId` must route to the instance hosting that call's in-memory session.
4. **SIP Trunking & Phone Number Inventory:**
   - Management routes for provisioning and associating real phone numbers with Auris agents.

---

## J. Final Recommendation

- **What is Safe to Do Next:** Proceed to planning Phase 4 carrier stream adapter design (e.g., Plivo/Twilio WebSocket framing and webhook signatures) under strict simulated or sandbox credentials.
- **What Must Remain Prohibited:**
  - Do NOT connect production telephony accounts or spend money.
  - Do NOT place real PSTN phone calls.
  - Do NOT deploy publicly or expose open ports.
  - Stop and await explicit user authorization before initiating Phase 4.
