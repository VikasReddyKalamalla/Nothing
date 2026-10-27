# Auris Phase 4.2 — Mock Telephony Sandbox Guide

## 1. Overview

The **Mock Telephony Sandbox** (`MockCarrierSandbox`) is a deterministic, provider-neutral simulation harness that enables full-lifecycle voice AI testing without connecting to real carriers, purchasing phone numbers, or incurring telecom or API costs.

All operations execute strictly in local process memory on `127.0.0.1` and against the local development/test PostgreSQL instance.

---

## 2. Running Focused and Full Test Suites

### Running Focused Phase 4.2 Tests
To run only the audio codec and sandbox unit tests in `@auris/runtime`:
```bash
npm run --workspace=@auris/runtime test tests/audio_codec.test.ts
npm run --workspace=@auris/runtime test tests/mock_carrier_sandbox.test.ts
```

To run the carrier sandbox integration tests in `@auris/api`:
```bash
npm run --workspace=@auris/api test tests/phase_4_2_carrier_sandbox_integration.test.ts
```

### Running the Entire Multi-Workspace Test Suite
To run all 267 automated tests across all workspaces:
```bash
npm test
```

### Building All Workspaces
To verify clean compilation and type-checking across all 4 workspaces (`@auris/database`, `@auris/runtime`, `@auris/api`, `@auris/web`):
```bash
npm run build
```

---

## 3. How to Execute Inbound & Outbound Simulations

### Inbound Call Simulation
Inbound calls simulate a remote party dialing an Auris agent from a synthetic phone number:

```ts
import { MockCarrierSandbox } from '@auris/runtime';

const sandbox = new MockCarrierSandbox();

// 1. Offer an incoming call
const { carrierCallId, offerEvent } = sandbox.simulateInboundCall({
  from: '+15550101',
  to: '+15550199',
  agentId: 'agent-uuid-here',
  organizationId: 'org-uuid-here',
});

// 2. Simulate remote caller answering
sandbox.simulateCallAnswer(carrierCallId);

// 3. Simulate remote caller hanging up
sandbox.simulateCallDisconnect(carrierCallId, 'REMOTE_PARTY_DISCONNECT');

// 4. Dispose sandbox
await sandbox.dispose();
```

### Outbound Call Simulation
Outbound calls simulate an Auris agent dialing an external destination:

```ts
import { MockCarrierSandbox } from '@auris/runtime';

const sandbox = new MockCarrierSandbox({
  eventDelayMs: 20, // Optional delay between ringing and answered events
});

// Initiate call
const result = await sandbox.initiateOutboundCall({
  callId: 'internal-call-uuid',
  from: '+15550100',
  to: '+15550101',
  direction: 'OUTBOUND',
});

console.log('Initiated call reference:', result.carrierCallId);

// Hang up call
await sandbox.terminateCall({
  carrierCallId: result.carrierCallId,
  reason: 'CONVERSATION_COMPLETE',
});
```

---

## 4. How to Trigger Supported Fault Scenarios

Configure `MockCarrierScenario` to inject deterministic faults without altering production code paths:

### Scenario 1: Outbound Initiation Failure
Simulate carrier trunk exhaustion or immediate dial rejection:
```ts
sandbox.updateScenario({
  forceInitiationFailure: true,
  forceInitiationFailureReason: 'CARRIER_TRUNKS_EXHAUSTED',
});

// initiateOutboundCall() will throw CarrierInitiationFailedError
```

### Scenario 2: Answer Timeout / Ringing Without Answer
Simulate a call where the destination rings indefinitely without answering:
```ts
sandbox.updateScenario({
  forceAnswerTimeout: true,
});
// Ringing event will be scheduled, but no answered event will ever be emitted.
```

### Scenario 3: Dropped Carrier Events
Simulate packet loss or carrier webhook delivery failure:
```ts
sandbox.updateScenario({
  droppedEventTypes: ['call.ringing'], // call.ringing will not be emitted
});
```

### Scenario 4: Duplicate Webhook Events
Simulate network retries where the carrier emits identical events:
```ts
sandbox.updateScenario({
  duplicateEvents: true,
});
// Each lifecycle event is dispatched twice, the second with isDuplicate: true
```

### Scenario 5: Temporary Carrier Unavailability
Simulate carrier gateway 503 outages:
```ts
sandbox.updateScenario({
  temporaryUnavailability: true,
});

// getHealth() returns { healthy: false }
// initiateOutboundCall() throws CarrierAdapterError ('CARRIER_UNAVAILABLE')
```

---

## 5. Audio Codec Processing with G.711 μ-Law

To test with standard 8kHz G.711 μ-law carrier audio:
```ts
import { G711MuLawCodec } from '@auris/runtime';

const codec = new G711MuLawCodec();

// Encode internal 16kHz PCM (640 bytes) -> Carrier 8kHz μ-law (160 bytes)
const mulawBytes = codec.encode(internalPcm16kBuffer);

// Decode Carrier 8kHz μ-law (160 bytes) -> Internal 16kHz PCM (640 bytes)
const pcm16kBytes = codec.decode(mulawBytes);
```

---

## 6. How to Verify That No Real Provider Can Be Contacted

1. **No External Dependencies:** The sandbox has no imports from Twilio, Plivo, Telnyx, or AWS SDKs.
2. **Localhost Binding:** Fastify and the WebSocket server bind exclusively to `127.0.0.1`.
3. **Synthetic Phone Numbers:** All numbers follow the `+15550100` to `+15550199` reserved range (RFC 2543 / North American NANP fictitious range).
4. **Mock Credentials:** HMAC secrets are set to local development values (`MOCK_WEBHOOK_SECRET` / `MOCK_STREAM_TOKEN_SECRET`) in `.env.local` or defaults.
5. **Fail-Closed Gateways:** If an unknown provider name is supplied, `TelephonyGateway` fails closed with `UNKNOWN_PROVIDER`.
