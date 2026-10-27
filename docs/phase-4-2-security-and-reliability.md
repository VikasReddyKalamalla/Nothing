# Auris Phase 4.2 — Security and Reliability Specification

## 1. Threat Model & Trust Boundaries

The Auris Voice AI platform operates under a multi-tenant model where multiple organizations share infrastructure.

```
       [ Untrusted Carrier Webhook / Media ]
                       │
             (HMAC / Stream Token)
                       ▼
    ═══════════════════════════════════════════  [Trust Boundary 1]
           Telephony Gateway & Verification
    ═══════════════════════════════════════════
                       ▼
    ═══════════════════════════════════════════  [Trust Boundary 2]
         PostgreSQL Tenant Records (Auth)
    ═══════════════════════════════════════════
                       ▼
         Voice Turn Runtime & Wallet Hold
```

### Threat Categories & Mitigations

| Threat | Attack Vector | Auris Defense Mechanism |
| :--- | :--- | :--- |
| **Forged Webhooks** | Attacker posts counterfeit status events to `/v1/telephony/webhook` | Canonical raw-body HMAC-SHA256 signature verification (`MockWebhookSignatureVerifier`). |
| **Webhook Replays** | Attacker replays valid past webhook to trigger duplicate state transitions | Timestamp freshness check ($\pm 300\text{s}$) + durable idempotency record in PostgreSQL (`CarrierWebhookEvent`). |
| **Conflicting Payload Attacks** | Attacker reuses an existing event ID with modified payload | SHA-256 payload hash verification; mismatches immediately return HTTP 409 `WEBHOOK_PAYLOAD_CONFLICT`. |
| **Stream Token Hijacking** | Attacker attempts to attach unauthorized socket to ongoing call | Short-lived (60s), single-purpose signed tokens bound to specific `callId` and `organizationId`. |
| **Stream Token Replay** | Attacker captures stream token and re-uses it to hijack audio | Single-use cryptographic nonce check (`StreamTokenManager`). Nonce is atomically consumed upon first connection. |
| **Cross-Tenant Call Access** | Tenant A attempts to view, listen, or control Tenant B's call | Webhook payload `callId` is checked against authoritative DB/gateway mappings; fails with `CROSS_TENANT_CALL_MISMATCH`. |
| **Terminal Call Revocation** | Late carrier packets attempt to revive completed/failed call | State machine enforces terminal state immutability; sockets are rejected with WebSocket close code 1008. |
| **Financial Overdraft** | Long-running call drains wallet below zero | Pre-auth hold (`createReservation`), mid-call lease checks, and hard prepaid balance capping at 0.0000. |
| **Memory Exhaustion (DoS)** | Slow media consumer or frame flooding | Bounded audio queues (50 frames, 64 KB total) with backpressure and socket closure on overflow. |

---

## 2. Distributed Nonce Store & Replay Protection

### Current Process-Local Implementation
`StreamTokenManager` currently tracks claimed nonces in process memory:
- `claimedNonces: Map<string, number>`
- Expired nonces pruned when cache size exceeds 5,000 entries.

### Future Distributed Contract (`IStreamTokenNonceStore`)
Located in [`packages/runtime/src/telephony/IStreamTokenNonceStore.ts`](file:///e:/Nothing/packages/runtime/src/telephony/IStreamTokenNonceStore.ts):
```ts
export interface IStreamTokenNonceStore {
  claimNonce(nonce: string, expiresAtSec: number): Promise<boolean>;
  pruneExpired(): Promise<number>;
  clear(): Promise<void>;
}
```

### Future Production Implementation Strategies
1. **Redis Implementation:**
   - Atomic `SET key "claimed" EX ttl NX`
   - Returns true if key was set (first claim), false if key existed (replay detected).
2. **PostgreSQL Implementation:**
   - `INSERT INTO stream_token_nonces (nonce, expires_at) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING`
   - Returning row count determines atomic claim.

---

## 3. Financial Invariants & Concurrency Safety

1. **Pre-Authorization Holds:** Before a call dials out or answers, `WalletService.createReservation` locks the organization wallet row via raw SQL `SELECT ... FOR UPDATE` and reserves funds for the initial block.
2. **Prepaid Balance Floor:** Under no circumstance does `wallets.balance_credits` become negative. If an unexpected carrier overrun exceeds available credits, the charge is capped at total balance and an unpaid debt record is logged.
3. **Idempotent Settlement:** Terminal calls are settled exactly once. Webhook retries returning the same terminal event return `ALREADY_SETTLED` without deducting additional credits.
4. **Automated Recovery Net:** If a call session terminates without an active in-memory session (or after an API crash), `reconcileTerminalCallReservations` releases or settles the held reservation in FIFO order (`createdAt: asc`).

---

## 4. Residual Risks & Single-Process Limitations

1. **Multi-Instance Nonce Sync:** In a multi-replica API deployment without Redis, a stream token could theoretically be presented to two different instances simultaneously if load-balanced across them. Deploying `IStreamTokenNonceStore` with Redis or PostgreSQL resolves this.
2. **In-Flight Audio Restoration:** Process crashes terminate the live WebSocket connection. Audio buffers buffered only in RAM are lost; however, durable database records, transcripts, and financial ledgers remain completely intact.
