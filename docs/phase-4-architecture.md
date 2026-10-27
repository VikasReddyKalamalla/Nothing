# Auris Architecture Specification: Phase 4
## Provider-Neutral Telephony Gateway & Real-Time Media Streaming

**Author:** Auris Core Platform Engineering  
**Phase:** 4 — Provider-Neutral Telephony Gateway  
**Status:** IMPLEMENTED & VERIFIED (Mock-First Boundary)  
**Safety Status:** Isolated Local Emulation Only (No live PSTN calls, no carrier spending, no external infrastructure)

---

## 1. System Overview & Objectives

Phase 4 establishes the provider-neutral telephony gateway layer for the Auris multi-tenant voice AI platform. It decouples the core conversational voice runtime (`CallSession`, `VoiceTurnOrchestrator`, `CallStateMachine`, `RuntimeWalletBridge`) from transport protocols and carrier-specific payload nuances.

```
                          ┌─────────────────────────────────────┐
                          │    Telephony Carrier Transport      │
                          │   (Local WebSocket / HTTP Mock)     │
                          └──────────────────┬──────────────────┘
                                             │
                       Raw HTTP Webhook      │    Bidirectional WebSocket
                       (x-auris-signature)   │    (Stream Token Auth)
                                             ▼
                          ┌─────────────────────────────────────┐
                          │     Auris Telephony Gateway         │
                          ├─────────────────────────────────────┤
                          │ • Raw-Body HMAC-SHA256 Verifier     │
                          │ • Replay Cache & Idempotency        │
                          │ • StreamTokenManager (Single-Use)   │
                          │ • MediaFrameCodec & Bounded Queues  │
                          └──────────────────┬──────────────────┘
                                             │
                     Normalized Telephony    │    Internal AudioFrame
                     Events                  │    (16kHz 16-bit PCM)
                                             ▼
                          ┌─────────────────────────────────────┐
                          │         Auris Voice Runtime         │
                          ├─────────────────────────────────────┤
                          │ • CallSession                       │
                          │ • CallStateMachine (Deterministic)  │
                          │ • VoiceTurnOrchestrator             │
                          │ • Streaming STT / LLM / TTS Adapters│
                          └──────────────────┬──────────────────┘
                                             │
                                             ▼
                          ┌─────────────────────────────────────┐
                          │    Control Plane & Persistence      │
                          ├─────────────────────────────────────┤
                          │ • RuntimeWalletBridge (Holds/Settle)│
                          │ • CarrierWebhookEvent (Deduplication│
                          │ • PostgreSQL 16 (Tenant Isolation)  │
                          └─────────────────────────────────────┘
```

---

## 2. Component Responsibilities

| Component | Location | Core Responsibilities |
| :--- | :--- | :--- |
| **`ITelephonyGatewayProvider`** | `packages/runtime` | Abstract contract defining lifecycle event normalization, media frame translation, and control frame encoding. |
| **`ITelephonyConnection`** | `packages/runtime` | Abstract handle for bidirectional stream communication with an active call leg. |
| **`MediaFrameCodec`** | `packages/runtime` | Encodes and decodes JSON/Base64 wire frames into internal `AudioFrame` objects; enforces max message size and max frame size. |
| **`MediaStreamSession`** | `packages/runtime` | Manages per-call WebSocket transport, bounded inbound and outbound audio queues, backpressure, idle timeouts, and barge-in clearing. |
| **`MockWebhookSignatureVerifier`**| `packages/runtime` | Validates canonical HTTP raw request bytes with HMAC-SHA256, constant-time comparison, timestamp tolerance, and replay cache. |
| **`StreamTokenManager`** | `packages/runtime` | Generates and validates short-lived, single-purpose HMAC-SHA256 signed stream tokens; enforces single-use nonce claiming and tenant isolation. |
| **`TelephonyGateway`** | `packages/runtime` | Coordinates registered provider adapters, trusted call ID resolution, active session registry, and audio routing. |
| **`TelephonyService`** | `apps/api` | Fastify-integrated service managing database idempotency (`CarrierWebhookEvent`), call status synchronization, and token issuance. |
| **`TelephonyRoutes`** | `apps/api` | Fastify route definitions for `POST /v1/telephony/webhook`, `POST /v1/telephony/stream-token`, and `GET /v1/telephony/stream`. |

---

## 3. Trust Boundaries & Authentication Model

### 3.1 Webhook Authentication
- **Canonical Signature Format:** `x-auris-signature: t=${timestamp},v1=${hmacHex}`.
- **Signed String:** `${timestamp}.${rawBodyString}`.
- **Raw-Body Preservation:** Fastify content parser preserves the unmutated incoming request buffer (`req.rawBody`), ensuring whitespace, key ordering, and character encoding differences do not invalidate signatures.
- **Timing Attacks:** Verified using `crypto.timingSafeEqual` over binary digests.
- **Replay Protection:** Two-tier protection:
  1. *In-Memory Replay Cache:* Rejects duplicate signatures within the 300-second tolerance window.
  2. *Durable Database Constraint:* Records `eventId` and `payloadHash` in `CarrierWebhookEvent` (`eventId @unique`).

### 3.2 Stream Authentication
- **Separation of Concerns:** Valid webhook credentials do *not* grant stream access.
- **Token Format:** Short-lived (60s TTL), single-purpose JWT-like HMAC-SHA256 token containing `{ callId, organizationId, purpose: "media_stream", expiresAt, nonce }`.
- **Tenant Authorization:** Generated exclusively via authenticated endpoint `POST /v1/telephony/stream-token`, requiring valid user JWT and verified membership in the call's owning organization.
- **Single-Use Enforcement:** The cryptographic nonce is atomically claimed upon connection. Reconnection with the same token is rejected with WebSocket close code `1008`.
- **Log Sanitization:** Sensitive tokens, signatures, and query parameters are redacted from logs (`[STREAM_TOKEN_REDACTED]`).

---

## 4. Audio Streaming, Backpressure & Barge-in

### 4.1 Internal AudioFrame Representation
```typescript
export interface AudioFrame {
  callId: string;
  payloadBytes: Buffer;
  encoding: 'pcm_16000' | 'pcm_8000' | 'mulaw_8000';
  sampleRate: number;
  channels: number;
  sequenceNumber?: number;
  timestampMs?: number;
}
```

### 4.2 Bounded Queues
- **Outbound Queue:** Max 50 frames (approx. 1 second of speech) or 64 KB cumulative bytes.
- **Overflow Policy:** Exceeding queue bounds emits `QueueOverflowError` and cleanly terminates the stream rather than allowing unbounded memory growth.
- **Idle Timeout:** Streams with no activity for 30 seconds trigger `IDLE_TIMEOUT` closure.

### 4.3 Speech Interruption (Barge-In)
When caller voice activity is detected by the VAD / STT stream:
1. `VoiceTurnOrchestrator` aborts ongoing LLM generation and cancels streaming TTS via `AbortController`.
2. `MediaStreamSession.clearBuffer()` is invoked:
   - Flushes all pending outbound audio frames in memory immediately.
   - Dispatches a `{ event: "clear", streamId }` control message over WebSocket to the client.
3. State machine transitions from `SPEAKING` to `LISTENING`.

---

## 5. Billing & State Invariants

- **Authority:** The Telephony Gateway **never** debits wallets directly. All financial transactions continue to flow exclusively through `RuntimeWalletBridge` and `WalletService`.
- **Pre-Authorization Hold:** Dialing or answering a call requires an active pre-authorization hold.
- **Terminal State Protection:** Terminal states (`COMPLETED`, `FAILED`) are idempotent and immutable. Delayed or out-of-order webhook events cannot revive a finalized call.
- **Hold Release:** Failed, unanswered, or rejected calls trigger hold release with ₹0.00 deduction.

---

## 6. Limitations & Future Real-Provider Integration Requirements

1. **Mock Scope:** Phase 4 uses mock telephony adapters. Live carrier networks (Plivo, Twilio, Tata Tele) are not connected.
2. **Distributed Replay Cache:** The local replay cache protects the single API process. When scaled across multiple replicas in Phase 5+, Redis or database-backed distributed replay checking must be configured.
3. **Audio Transcoding:** The mock protocol uses Linear PCM 16kHz. Real carriers frequently use G.711 u-law (`mulaw_8000`) or 8kHz sample rates; adapter-level codecs will perform standard transcoding.
