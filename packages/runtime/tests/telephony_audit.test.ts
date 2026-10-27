import { describe, it, expect, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  TelephonyGateway,
  MediaStreamSession,
  MockWebhookSignatureVerifier,
  StreamTokenManager,
  MockTelephonyGatewayAdapter,
  QueueOverflowError,
  TelephonyError,
} from '../src/index.js';

describe('Phase 4.1 Audit: Runtime Telephony Security, Concurrency & Bounded Backpressure', () => {
  const MOCK_WEBHOOK_SECRET = 'audit-mock-webhook-secret-key-12345';
  const MOCK_STREAM_SECRET = 'audit-mock-stream-secret-key-67890';

  describe('SEC-01: Cross-Tenant Call ID Spoofing in Gateway Mapping', () => {
    it('strictly rejects webhook when client-supplied callId conflicts with trusted server-side call reference mapping', async () => {
      const tokenManager = new StreamTokenManager({ secret: MOCK_STREAM_SECRET });
      const verifier = new MockWebhookSignatureVerifier({ secret: MOCK_WEBHOOK_SECRET });
      const adapter = new MockTelephonyGatewayAdapter();
      const gateway = new TelephonyGateway(tokenManager);
      gateway.registerProvider(adapter, verifier);

      // Register server-side trusted mapping: carrier leg 'carrier-leg-tenantA' -> 'call-tenant-A'
      gateway.registerCallMapping('carrier-leg-tenantA', 'call-tenant-A');

      // Attacker sends webhook for carrier-leg-tenantA but injects callId: 'call-victim-B'
      const spoofedPayload = {
        event: 'disconnected',
        carrierCallId: 'carrier-leg-tenantA',
        callId: 'call-victim-B', // SPOOFED!
        reason: 'ATTACKER_DISCONNECT',
        timestamp: Date.now(),
      };
      const rawBody = Buffer.from(JSON.stringify(spoofedPayload));
      const headers = { 'x-auris-signature': verifier.formatHeader(rawBody) };

      // Gateway MUST reject cross-tenant mismatch rather than routing to call-victim-B
      await expect(
        gateway.handleWebhook('mock-telephony', { rawBody, headers })
      ).rejects.toThrow(/mismatch|cross-tenant/i);
    });
  });

  describe('SEC-03: Orphaned Socket Leak & Superseded Connection Cleanup', () => {
    class MockWs {
      public closed = false;
      public closeCode?: number;
      public closeReason?: string;
      public listeners: Map<string, Function[]> = new Map();
      public readyState = 1;

      send() {}
      close(code?: number, reason?: string) {
        this.closed = true;
        this.closeCode = code;
        this.closeReason = reason;
        this.emit('close', code, reason);
      }
      on(event: string, fn: Function) {
        const arr = this.listeners.get(event) || [];
        arr.push(fn);
        this.listeners.set(event, arr);
        return this;
      }
      removeListener(event: string, fn: Function) {
        const arr = this.listeners.get(event) || [];
        this.listeners.set(event, arr.filter((f) => f !== fn));
        return this;
      }
      emit(event: string, ...args: any[]) {
        for (const fn of this.listeners.get(event) || []) {
          fn(...args);
        }
      }
    }

    it('cleanly closes previous socket when a new WebSocket is attached to an active session', () => {
      const session = new MediaStreamSession({
        callId: 'call-1',
        providerCallReference: 'carrier-1',
      });

      const ws1 = new MockWs();
      const ws2 = new MockWs();

      session.attachWebSocket(ws1 as any);
      expect(session.status).toBe('open');

      // Attach second WebSocket
      session.attachWebSocket(ws2 as any);

      // ws1 must be closed and superseded, not orphaned!
      expect(ws1.closed).toBe(true);
      expect(ws1.closeCode).toBe(1000);
      expect(ws2.closed).toBe(false);
      expect(session.status).toBe('open');
    });
  });

  describe('REL-01: Bounded Backpressure & Slow-Consumer Socket Buffer Accounting', () => {
    class SlowConsumerWs {
      public bufferedAmount = 0;
      public closed = false;
      public readyState = 1;
      public listeners: Map<string, Function[]> = new Map();

      send(data: string) {
        // Simulate slow network: socket buffers data in memory
        this.bufferedAmount += Buffer.byteLength(data, 'utf8');
      }
      close() {
        this.closed = true;
      }
      on(event: string, fn: Function) {
        const arr = this.listeners.get(event) || [];
        arr.push(fn);
        this.listeners.set(event, arr);
        return this;
      }
      removeListener() { return this; }
      emit(event: string, ...args: any[]) {
        for (const fn of this.listeners.get(event) || []) fn(...args);
      }
    }

    it('accounts for socket bufferedAmount and throws QueueOverflowError when slow consumer chokes', async () => {
      const session = new MediaStreamSession({
        callId: 'call-slow',
        providerCallReference: 'carrier-slow',
        config: {
          maxQueuedBytes: 1000,
          maxFrameSize: 500,
          maxQueuedFrames: 10,
        },
      });

      const slowWs = new SlowConsumerWs();
      session.attachWebSocket(slowWs as any);

      const frame = {
        callId: 'call-slow',
        payloadBytes: Buffer.alloc(200),
        encoding: 'pcm_16000' as const,
        sampleRate: 16000,
        channels: 1,
      };

      // Send frames: each frame is ~350 bytes JSON
      await session.sendAudioFrame(frame); // bufferedAmount ~ 350
      await session.sendAudioFrame(frame); // bufferedAmount ~ 700

      // Third frame would push bufferedAmount > 1000 bytes -> MUST throw QueueOverflowError!
      await expect(session.sendAudioFrame(frame)).rejects.toThrow(QueueOverflowError);
    });
  });

  describe('SEC-06 & SEC-07: Webhook Signature Verifier Tight Bounds & Hex Validation', () => {
    const verifier = new MockWebhookSignatureVerifier({
      secret: MOCK_WEBHOOK_SECRET,
      toleranceSeconds: 300,
    });

    it('strictly rejects future timestamps exceeding clock drift threshold (+30s)', () => {
      const rawBody = Buffer.from('{"event":"ringing"}');
      const futureTimestamp = Math.floor(Date.now() / 1000) + 60; // 60s in the future
      const header = verifier.formatHeader(rawBody, futureTimestamp);

      const res = verifier.verify({
        rawBody,
        headers: { 'x-auris-signature': header },
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe('EXPIRED_TIMESTAMP');
    });

    it('strictly rejects odd-length or malformed hex signatures', () => {
      const rawBody = Buffer.from('{"event":"ringing"}');
      const nowSec = Math.floor(Date.now() / 1000);
      const malformedHeader = `t=${nowSec},v1=abc123not64chars`;

      const res = verifier.verify({
        rawBody,
        headers: { 'x-auris-signature': malformedHeader },
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe('MALFORMED_HEADER');
    });

    it('validates exact raw request bytes across whitespace, key ordering, and unicode variations', () => {
      // 1. Whitespace variance
      const originalWithSpaces = Buffer.from('{\n  "event": "ringing",\n  "leg": "c-1"\n}');
      const collapsedWithoutSpaces = Buffer.from('{"event":"ringing","leg":"c-1"}');
      const headerSpaces = verifier.formatHeader(originalWithSpaces);

      expect(verifier.verify({ rawBody: originalWithSpaces, headers: { 'x-auris-signature': headerSpaces } }).valid).toBe(true);
      expect(verifier.verify({ rawBody: collapsedWithoutSpaces, headers: { 'x-auris-signature': headerSpaces } }).valid).toBe(false);

      // 2. Key ordering variance
      const keyOrderA = Buffer.from('{"a":1,"b":2}');
      const keyOrderB = Buffer.from('{"b":2,"a":1}');
      const headerA = verifier.formatHeader(keyOrderA);

      expect(verifier.verify({ rawBody: keyOrderA, headers: { 'x-auris-signature': headerA } }).valid).toBe(true);
      expect(verifier.verify({ rawBody: keyOrderB, headers: { 'x-auris-signature': headerA } }).valid).toBe(false);

      // 3. Unicode and escaped chars
      const unicodeBody = Buffer.from('{"text":"నమస్కారం","name":"Dr. Reddy\\nClinic"}', 'utf8');
      const headerUnicode = verifier.formatHeader(unicodeBody);
      expect(verifier.verify({ rawBody: unicodeBody, headers: { 'x-auris-signature': headerUnicode } }).valid).toBe(true);
    });
  });

  describe('AUDIT B: Atomic Single-Use Token Concurrency', () => {
    it('under concurrent simultaneous claim attempts, exactly one claim succeeds and all others are rejected', async () => {
      const tokenManager = new StreamTokenManager({ secret: MOCK_STREAM_SECRET });
      const { token } = tokenManager.generateToken({
        callId: 'call-concurrency-1',
        organizationId: 'org-1',
      });

      // Launch 10 simultaneous claim attempts
      const attempts = Array.from({ length: 10 }).map(async () => {
        try {
          tokenManager.verifyAndClaimToken(token, 'call-concurrency-1', 'org-1');
          return 'SUCCESS';
        } catch (err: any) {
          return err.name || 'ERROR';
        }
      });

      const results = await Promise.all(attempts);

      const successCount = results.filter((r) => r === 'SUCCESS').length;
      const reusedCount = results.filter((r) => r === 'StreamTokenReusedError').length;

      expect(successCount).toBe(1);
      expect(reusedCount).toBe(9);
    });

    it('allows independent consumption of two different tokens generated for the same call', () => {
      const tokenManager = new StreamTokenManager({ secret: MOCK_STREAM_SECRET });
      const token1 = tokenManager.generateToken({ callId: 'call-1', organizationId: 'org-1' }).token;
      const token2 = tokenManager.generateToken({ callId: 'call-1', organizationId: 'org-1' }).token;

      expect(token1).not.toBe(token2);

      const payload1 = tokenManager.verifyAndClaimToken(token1, 'call-1', 'org-1');
      const payload2 = tokenManager.verifyAndClaimToken(token2, 'call-1', 'org-1');

      expect(payload1.nonce).not.toBe(payload2.nonce);
      expect(payload1.callId).toBe('call-1');
      expect(payload2.callId).toBe('call-1');
    });
  });
});
