# AURIS — PHASE 1 DESIGN DECISIONS & TRANSACTION SPECIFICATION

## 1. RECONCILIATION: CONFIGURABLE RECORDING RETENTION VS 90-DAY DEFAULTS

### Context
In the competitor screenshots (Outpero), the following copy was observed:
> *"Call recordings are kept for 90 days, then automatically deleted — the transcript and summary stay for as long as your account is active."*

### Auris Reconciled Policy
1. **Configurable Policy, Not a Static Constant:**
   - 90 days is established as the **default initial preset** for new organizations to provide an out-of-the-box expectation.
   - However, Auris implements this via the `compliance_policies` table on an organization-level:
     - `retention_days` (INTEGER NULLABLE):
       - `0`: Zero-retention mode (audio purged immediately post-transcription).
       - `30`, `60`, `90`, `180`, `365`: Standard retention windows.
       - `NULL`: Indefinite retention (governed by custom enterprise contracts).
     - `legal_hold` (BOOLEAN): Disables automated deletion when regulatory or litigation holds apply.
2. **Deterministic Cleanup Engine:**
   - Recordings have an explicit `expires_at` column: `expires_at = call.ended_at + INTERVAL 'retention_days days'`.
   - The automated cleanup worker performs:
     ```sql
     SELECT id, s3_key, call_id 
     FROM recordings 
     WHERE expires_at <= NOW() 
       AND is_deleted = false 
       AND legal_hold = false 
     FOR UPDATE SKIP LOCKED 
     LIMIT 500;
     ```
   - Files are deleted from encrypted object storage, `is_deleted` is flagged as `true`, and an audit log entry is recorded.
   - Transcripts, summaries, and structured outcomes remain available for the customer's account lifetime unless an explicit GDPR/DPDP Right-To-Be-Forgotten request is executed.

---

## 2. TRANSACTION MODEL: WALLET RESERVATIONS & IDEMPOTENT SETTLEMENT

To ensure financial integrity and prevent cross-tenant balance pollution or race conditions, Auris models wallet interactions around strict double-entry balance tracking with pre-call reservation holds.

### Core Ledger Invariant
$$\text{available\_balance} = \text{balance\_credits} - \text{reserved\_credits}$$
- `balance_credits`: Total settled funds in the wallet.
- `reserved_credits`: Cumulative sum of currently held active reservations.
- `available_balance`: Must remain $\ge 0$ at all times.

### State Transitions for a Call Reservation & Settlement

```
               [ Call Request ]
                      |
           (Available >= Hold Req?)
             /                 \
          [No]                 [Yes]
           |                     |
     [REJECT: 402]         [Create Hold]
   (INSUFFICIENT_FUNDS)          |
                      wallet.reserved += hold
                      res.status = 'HELD'
                                 |
                        [ Call Executed ]
                       /        |        \
             [Connected]     [Busy]     [Failed/Worker Crash]
                  |             |                 |
            [Calculate]    [Release All]    [Reconcile via Plivo/Timer]
         (duration blocks)  charge = 0            |
                  |             |           (duration settled)
                  \             /                 |
               [Atomic Settlement Transaction] <--+
                   wallet.balance -= charge
                   wallet.reserved -= hold
                   res.status = 'SETTLED'
                   ledger += CALL_SETTLEMENT
```

### 1. Atomic Balance Reservation (`CALL_HOLD`)
Before any carrier leg is placed:
```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

SELECT id, organization_id, balance_credits, reserved_credits 
FROM wallets 
WHERE organization_id = :org_id 
FOR UPDATE;

-- Check solvency:
IF (balance_credits - reserved_credits) < :requested_hold THEN
    ROLLBACK;
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
END IF;

-- Apply hold:
UPDATE wallets 
SET reserved_credits = reserved_credits + :requested_hold,
    updated_at = NOW()
WHERE id = :wallet_id;

INSERT INTO wallet_reservations (
    id, wallet_id, call_id, reserved_amount, status, expires_at, created_at
) VALUES (
    :reservation_id, :wallet_id, :call_id, :requested_hold, 'HELD', NOW() + INTERVAL '1 hour', NOW()
);

INSERT INTO credit_transactions (
    id, wallet_id, amount_credits, balance_after, type, reference_id, idempotency_key, created_at
) VALUES (
    gen_random_uuid(), :wallet_id, 0, (balance_credits - (reserved_credits + :requested_hold)), 
    'CALL_HOLD', :call_id, 'hold:' || :call_id, NOW()
);

COMMIT;
```

### 2. Idempotent Settlement (`CALL_SETTLEMENT`)
When the call terminates:
```sql
BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED;

SELECT * FROM wallet_reservations 
WHERE call_id = :call_id 
FOR UPDATE;

-- Idempotency check:
IF wallet_reservations.status != 'HELD' THEN
    -- Already settled or cancelled, return existing state
    COMMIT;
    RETURN;
END IF;

SELECT * FROM wallets 
WHERE id = wallet_reservations.wallet_id 
FOR UPDATE;

-- Settlement calculation:
-- Actual charge computed via tariff:
-- billable_seconds = CEIL(duration_seconds / 30) * 30
-- charge = (billable_seconds / 60) * rate_per_minute

UPDATE wallets 
SET balance_credits = balance_credits - :actual_charge,
    reserved_credits = reserved_credits - wallet_reservations.reserved_amount,
    updated_at = NOW()
WHERE id = wallet_reservations.wallet_id;

UPDATE wallet_reservations 
SET status = 'SETTLED',
    settled_amount = :actual_charge,
    updated_at = NOW()
WHERE id = wallet_reservations.id;

INSERT INTO credit_transactions (
    id, wallet_id, amount_credits, balance_after, type, reference_id, idempotency_key, created_at
) VALUES (
    gen_random_uuid(), wallets.id, -:actual_charge, (wallets.balance_credits - :actual_charge),
    'CALL_SETTLEMENT', :call_id, 'settle:' || :call_id, NOW()
);

COMMIT;
```

### 3. Immediate Cancellation / Unanswered Calls (`CALL_RELEASE`)
For unanswered, busy, or failed calls:
- Actual charge is **0.00**.
- `reserved_credits = reserved_credits - reserved_amount`.
- Net change to `balance_credits` is **0.00**.
- Status updated to `'CANCELLED'`.

### 4. Worker Crash & Orphan Hold Recovery
If a voice runtime worker crashes mid-call:
- An asynchronous reconciliation job inspects reservations where `status = 'HELD'` and `expires_at <= NOW()`.
- It queries the carrier API with `carrier_call_id`.
- If the carrier reports the call ended, it settles with the carrier's reported duration.
- If the carrier has no record or reports the call was dropped before connect, it releases the hold.

---

## 3. PROVIDER ABSTRACTION PRINCIPLE

All external providers (Plivo, Sarvam AI, Cartesia, Google Gemini) are isolated behind strict abstract interfaces:
- `ITelephonyAdapter`: Inbound/outbound call signaling, audio streams, hangup, DTMF.
- `ISpeechToTextAdapter`: Streaming audio ingestion, turn boundary events, transcripts.
- `ITextToSpeechAdapter`: Streaming text/token ingestion, streaming PCM audio buffer chunks.
- `IConversationEngine`: Context management, prompt generation, tool calling.

Phase 1 provides full **Mock Adapters** that enable complete offline development, testing, and determinism without spending money or requiring live carrier numbers.
