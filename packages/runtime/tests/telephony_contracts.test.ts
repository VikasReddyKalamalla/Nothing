import { describe, it, expect, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  MediaFrameCodec,
  MediaStreamSession,
  MockWebhookSignatureVerifier,
  StreamTokenManager,
  TelephonyEventNormalizer,
  MockTelephonyGatewayAdapter,
  DEFAULT_MEDIA_CONFIG,
  QueueOverflowError,
  MalformedMediaFrameError,
  UnsupportedAudioFormatError,
  ExpiredStreamTokenError,
  InvalidStreamTokenError,
  StreamTokenReusedError,
  AudioFrame,
} from '../src/index.js';

describe('Auris Phase 4: Provider-Neutral Telephony Contracts & Streaming Tests', () => {
  const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret-phase4-secure-key-123';
  const MOCK_STREAM_SECRET = 'mock-stream-secret-phase4-secure-key-456';

  describe('A. Provider Contract & Capabilities', () => {
    it('MockTelephonyGatewayAdapter conforms to provider-neutral contract', () => {
      const adapter = new MockTelephonyGatewayAdapter();
      expect(adapter.providerId).toBe('mock-telephony');
      expect(adapter.capabilities.supportsBidiStreaming).toBe(true);
      expect(adapter.capabilities.supportsBargeInFlush).toBe(true);
      expect(adapter.capabilities.supportedEncodings).toContain('pcm_16000');
      expect(adapter.capabilities.maxFrameSizeBytes).toBe(4096);
    });

    it('creates and manages session connection deterministically', async () => {
      const adapter = new MockTelephonyGatewayAdapter();
      const connection = adapter.createConnection('call-1', 'carrier-ref-1');
      expect(connection.callId).toBe('call-1');
      expect(connection.providerCallReference).toBe('carrier-ref-1');
      expect(connection.status).toBe('connecting');

      await adapter.dispose();
      expect(connection.status).toBe('closed');
    });
  });

  describe('B. MediaFrameCodec & Protocol Framing', () => {
    let codec: MediaFrameCodec;

    beforeEach(() => {
      codec = new MediaFrameCodec({
        maxFrameSize: 1024,
        maxMessageSize: 4096,
      });
    });

    it('decodes valid start frame and extracts normalized event', () => {
      const startMsg = JSON.stringify({
        event: 'start',
        streamId: 'stream-123',
        callReference: 'carrier-leg-99',
        mediaFormat: {
          encoding: 'audio/x-l16',
          sampleRate: 16000,
          channels: 1,
        },
        customParameters: {
          callId: 'call-uuid-1',
        },
      });

      const decoded = codec.decode(startMsg, 'call-uuid-1');
      expect(decoded.type).toBe('event');
      if (decoded.type === 'event') {
        expect(decoded.event.eventType).toBe('media.started');
        expect(decoded.event.providerCallReference).toBe('carrier-leg-99');
        expect(decoded.event.callId).toBe('call-uuid-1');
        expect(decoded.event.payload.streamId).toBe('stream-123');
      }
    });

    it('decodes valid audio media message with base64 payload', () => {
      const rawAudio = Buffer.from(new Uint8Array(640)); // 20ms of 16kHz PCM
      const b64 = rawAudio.toString('base64');
      const mediaMsg = JSON.stringify({
        event: 'media',
        streamId: 'stream-123',
        sequenceNumber: 1,
        media: {
          payload: b64,
          timestamp: 1700000000,
        },
      });

      const decoded = codec.decode(mediaMsg, 'call-uuid-1');
      expect(decoded.type).toBe('frame');
      if (decoded.type === 'frame') {
        expect(decoded.frame.callId).toBe('call-uuid-1');
        expect(decoded.frame.payloadBytes.length).toBe(640);
        expect(decoded.frame.sequenceNumber).toBe(1);
        expect(decoded.frame.sampleRate).toBe(16000);
      }
    });

    it('encodes internal audio frame to mock protocol JSON string', () => {
      const frame: AudioFrame = {
        callId: 'call-uuid-1',
        payloadBytes: Buffer.from('test-audio-bytes'),
        encoding: 'pcm_16000',
        sampleRate: 16000,
        channels: 1,
        sequenceNumber: 42,
        timestampMs: 12345,
      };

      const encoded = codec.encodeAudio(frame, 'stream-123', 42);
      const parsed = JSON.parse(encoded);
      expect(parsed.event).toBe('media');
      expect(parsed.streamId).toBe('stream-123');
      expect(parsed.sequenceNumber).toBe(42);
      expect(parsed.media.payload).toBe(Buffer.from('test-audio-bytes').toString('base64'));
    });

    it('rejects oversized JSON message', () => {
      const giantMsg = JSON.stringify({
        event: 'media',
        streamId: 'stream-1',
        padding: 'x'.repeat(5000),
      });

      expect(() => codec.decode(giantMsg)).toThrow(MalformedMediaFrameError);
    });

    it('rejects oversized decoded audio frame', () => {
      const giantAudio = Buffer.alloc(2048); // exceeds maxFrameSize of 1024
      const mediaMsg = JSON.stringify({
        event: 'media',
        streamId: 'stream-1',
        media: { payload: giantAudio.toString('base64') },
      });

      expect(() => codec.decode(mediaMsg)).toThrow(MalformedMediaFrameError);
    });

    it('rejects invalid JSON', () => {
      expect(() => codec.decode('{ bad json')).toThrow(MalformedMediaFrameError);
    });

    it('rejects invalid base64 characters', () => {
      const msg = JSON.stringify({
        event: 'media',
        streamId: 'stream-1',
        media: { payload: '!!!NOT_BASE64&&&' },
      });
      expect(() => codec.decode(msg)).toThrow(MalformedMediaFrameError);
    });

    it('rejects negative sequence numbers', () => {
      const msg = JSON.stringify({
        event: 'media',
        streamId: 'stream-1',
        sequenceNumber: -5,
        media: { payload: Buffer.from('pcm').toString('base64') },
      });
      expect(() => codec.decode(msg)).toThrow(MalformedMediaFrameError);
    });

    it('rejects unsupported audio encoding', () => {
      const msg = JSON.stringify({
        event: 'start',
        streamId: 'stream-1',
        callReference: 'carrier-1',
        mediaFormat: { encoding: 'audio/mp3', sampleRate: 44100, channels: 2 },
      });
      expect(() => codec.decode(msg)).toThrow(UnsupportedAudioFormatError);
    });
  });

  describe('C. Bounded Queues, Backpressure & Barge-in', () => {
    class MockWebSocket {
      public sent: string[] = [];
      public closed = false;
      public closeCode?: number;
      public closeReason?: string;
      public listeners: Map<string, Function[]> = new Map();
      public readyState = 1; // OPEN

      send(data: string) {
        this.sent.push(data);
      }
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

    it('enforces outbound queue frame count and byte bounds', async () => {
      const session = new MediaStreamSession({
        callId: 'call-1',
        providerCallReference: 'carrier-1',
        config: {
          maxQueuedFrames: 3,
          maxQueuedBytes: 2048,
          maxFrameSize: 512,
        },
      });

      const ws = new MockWebSocket();
      session.attachWebSocket(ws as any);

      const frame: AudioFrame = {
        callId: 'call-1',
        payloadBytes: Buffer.alloc(200),
        encoding: 'pcm_16000',
        sampleRate: 16000,
        channels: 1,
      };

      // Send 3 frames successfully
      await session.sendAudioFrame(frame);
      await session.sendAudioFrame(frame);
      await session.sendAudioFrame(frame);

      expect(ws.sent.length).toBe(3);
    });

    it('purges outbound queue and transmits clear frame on barge-in', async () => {
      const session = new MediaStreamSession({
        callId: 'call-1',
        providerCallReference: 'carrier-1',
      });

      const ws = new MockWebSocket();
      session.attachWebSocket(ws as any);

      // Trigger barge-in clearBuffer
      let clearedEmitted = false;
      session.on('bufferCleared', () => {
        clearedEmitted = true;
      });

      await session.clearBuffer();

      expect(clearedEmitted).toBe(true);
      const lastSent = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(lastSent.event).toBe('clear');
      expect(session.getOutboundQueueStats().frames).toBe(0);
    });

    it('rejects late incoming audio after session is closed', async () => {
      const session = new MediaStreamSession({
        callId: 'call-1',
        providerCallReference: 'carrier-1',
      });

      const ws = new MockWebSocket();
      session.attachWebSocket(ws as any);

      let framesReceived = 0;
      session.on('frame', () => {
        framesReceived++;
      });

      await session.close('CALL_ENDED');
      expect(session.status).toBe('closed');

      // Simulate incoming frame after closure
      const lateMsg = JSON.stringify({
        event: 'media',
        streamId: session.streamId,
        media: { payload: Buffer.from('late-pcm').toString('base64') },
      });
      ws.emit('message', lateMsg, false);

      expect(framesReceived).toBe(0);
    });

    it('idempotently cleans up resources on repeated close() calls', async () => {
      const session = new MediaStreamSession({
        callId: 'call-1',
        providerCallReference: 'carrier-1',
      });

      const ws = new MockWebSocket();
      session.attachWebSocket(ws as any);

      await session.close('FIRST_CLOSE');
      await session.close('SECOND_CLOSE');
      expect(session.status).toBe('closed');
      expect(ws.closed).toBe(true);
    });
  });

  describe('D. Webhook HMAC-SHA256 Verification & Replay Protection', () => {
    let verifier: MockWebhookSignatureVerifier;

    beforeEach(() => {
      verifier = new MockWebhookSignatureVerifier({
        secret: MOCK_WEBHOOK_SECRET,
        toleranceSeconds: 300, // 5 min
      });
    });

    it('accepts valid HMAC-SHA256 signature with raw request bytes', () => {
      const rawBody = Buffer.from(JSON.stringify({ event: 'ringing', callReference: 'c-100' }));
      const nowSec = Math.floor(Date.now() / 1000);
      const header = verifier.formatHeader(rawBody, nowSec);

      const result = verifier.verify({
        rawBody,
        headers: { 'x-auris-signature': header },
      });

      expect(result.valid).toBe(true);
      expect(result.reason).toBe('VALID');
      expect(result.timestamp).toBe(nowSec);
    });

    it('rejects missing signature header', () => {
      const rawBody = Buffer.from('{"event":"test"}');
      const result = verifier.verify({
        rawBody,
        headers: {},
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('MISSING_SIGNATURE');
    });

    it('rejects tampered body (raw body modified after signing)', () => {
      const originalBody = Buffer.from('{"amount":100}');
      const tamperedBody = Buffer.from('{"amount":999}');
      const header = verifier.formatHeader(originalBody);

      const result = verifier.verify({
        rawBody: tamperedBody,
        headers: { 'x-auris-signature': header },
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('INVALID_SIGNATURE');
    });

    it('rejects expired timestamp beyond tolerance window', () => {
      const rawBody = Buffer.from('{"event":"ringing"}');
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 301; // 301s ago (> 300s limit)
      const header = verifier.formatHeader(rawBody, expiredTimestamp);

      const result = verifier.verify({
        rawBody,
        headers: { 'x-auris-signature': header },
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('EXPIRED_TIMESTAMP');
    });

    it('prevents replay of previously verified request within tolerance window', () => {
      const rawBody = Buffer.from('{"event":"answered"}');
      const nowSec = Math.floor(Date.now() / 1000);
      const header = verifier.formatHeader(rawBody, nowSec);

      // First verification: success
      const first = verifier.verify({
        rawBody,
        headers: { 'x-auris-signature': header },
      });
      expect(first.valid).toBe(true);

      // Second verification of identical signed request: rejected as replay
      const second = verifier.verify({
        rawBody,
        headers: { 'x-auris-signature': header },
      });
      expect(second.valid).toBe(false);
      expect(second.reason).toBe('REPLAY_DETECTED');
    });

    it('fails closed when verifier secret is empty', () => {
      expect(() => new MockWebhookSignatureVerifier({ secret: '' })).toThrow();
    });
  });

  describe('E. Secure Stream Authentication & Single-Use Tokens', () => {
    let tokenManager: StreamTokenManager;

    beforeEach(() => {
      tokenManager = new StreamTokenManager({
        secret: MOCK_STREAM_SECRET,
        defaultTtlSeconds: 60,
      });
    });

    it('generates and successfully validates single-purpose stream token', () => {
      const { token } = tokenManager.generateToken({
        callId: 'call-100',
        organizationId: 'org-1',
      });

      const payload = tokenManager.verifyAndClaimToken(token, 'call-100', 'org-1');
      expect(payload.callId).toBe('call-100');
      expect(payload.organizationId).toBe('org-1');
      expect(payload.purpose).toBe('media_stream');
      expect(payload.nonce).toBeDefined();
    });

    it('rejects expired stream token', () => {
      const { token } = tokenManager.generateToken({
        callId: 'call-100',
        organizationId: 'org-1',
        ttlSeconds: -10, // Expired 10s ago
      });

      expect(() => tokenManager.verifyAndClaimToken(token, 'call-100', 'org-1')).toThrow(
        ExpiredStreamTokenError
      );
    });

    it('rejects tampered token signature', () => {
      const { token } = tokenManager.generateToken({
        callId: 'call-100',
        organizationId: 'org-1',
      });

      const [payloadB64] = token.split('.');
      const tamperedToken = `${payloadB64}.tampered_signature_hex`;

      expect(() => tokenManager.verifyAndClaimToken(tamperedToken, 'call-100', 'org-1')).toThrow(
        InvalidStreamTokenError
      );
    });

    it('rejects token bound to a different call ID', () => {
      const { token } = tokenManager.generateToken({
        callId: 'call-A',
        organizationId: 'org-1',
      });

      expect(() => tokenManager.verifyAndClaimToken(token, 'call-B', 'org-1')).toThrow(
        InvalidStreamTokenError
      );
    });

    it('rejects cross-tenant token presentation', () => {
      const { token } = tokenManager.generateToken({
        callId: 'call-A',
        organizationId: 'org-Attacker',
      });

      expect(() => tokenManager.verifyAndClaimToken(token, 'call-A', 'org-Victim')).toThrow(
        InvalidStreamTokenError
      );
    });

    it('enforces single-use token and rejects reuse', () => {
      const { token } = tokenManager.generateToken({
        callId: 'call-100',
        organizationId: 'org-1',
      });

      // Claim 1: success
      tokenManager.verifyAndClaimToken(token, 'call-100', 'org-1');

      // Claim 2: rejected as reused
      expect(() => tokenManager.verifyAndClaimToken(token, 'call-100', 'org-1')).toThrow(
        StreamTokenReusedError
      );
    });

    it('redacts stream tokens from log representations', () => {
      const sanitized = StreamTokenManager.sanitize('secret.token.signature');
      expect(sanitized).toBe('[STREAM_TOKEN_REDACTED]');
      expect(sanitized).not.toContain('secret');
    });
  });

  describe('F. Telephony Event Normalizer', () => {
    it('normalizes provider event lifecycle states', () => {
      const rawAnswered = {
        event: 'answered',
        callReference: 'carrier-leg-55',
        callId: 'call-123',
        timestamp: 1700000000000,
      };

      const normalized = TelephonyEventNormalizer.normalizeMockEvent(rawAnswered);
      expect(normalized.eventType).toBe('call.answered');
      expect(normalized.providerCallReference).toBe('carrier-leg-55');
      expect(normalized.callId).toBe('call-123');
      expect(normalized.providerId).toBe('mock-telephony');
    });

    it('strips credentials and sensitive keys from normalized payload', () => {
      const raw = {
        event: 'disconnected',
        callReference: 'carrier-leg-55',
        reason: 'NORMAL_CLEARING',
        details: {
          clientSecret: 'secret_123',
          authToken: 'token_456',
          apiKey: 'key_789',
          sipCode: 200,
        },
      };

      const normalized = TelephonyEventNormalizer.normalizeMockEvent(raw);
      expect(normalized.payload.reason).toBe('NORMAL_CLEARING');
      expect(normalized.payload.sipCode).toBe(200);
      expect(normalized.payload.clientSecret).toBeUndefined();
      expect(normalized.payload.authToken).toBeUndefined();
      expect(normalized.payload.apiKey).toBeUndefined();
    });
  });
});
