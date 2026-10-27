import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  MockCarrierSandbox,
  CarrierInitiationFailedError,
  CarrierAdapterError,
  InvalidCarrierEventError,
  MemoryStreamTokenNonceStore,
  StreamTokenManager,
  StreamTokenReusedError,
  ManualRecoverySchedulerHarness,
} from '../src/index.js';

describe('Workstream C, D, G, K, L: MockCarrierSandbox, Fault Injection, Nonce Store & Scheduler', () => {
  let sandbox: MockCarrierSandbox;

  beforeEach(() => {
    sandbox = new MockCarrierSandbox({ eventDelayMs: 0 });
  });

  afterEach(async () => {
    await sandbox.dispose();
  });

  describe('ICarrierAdapter Contract & Capabilities', () => {
    it('declares provider identity and telephony capabilities', () => {
      expect(sandbox.id).toBe('mock-carrier-sandbox');
      expect(sandbox.providerId).toBe('mock-carrier-sandbox');
      expect(sandbox.capabilities.supportsInbound).toBe(true);
      expect(sandbox.capabilities.supportsOutbound).toBe(true);
      expect(sandbox.capabilities.supportsBidiStreaming).toBe(true);
      expect(sandbox.capabilities.supportedEncodings).toContain('mulaw_8000');
      expect(sandbox.capabilities.supportedEncodings).toContain('pcm_16000');
    });

    it('reports health status accurately', async () => {
      const health = await sandbox.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.latencyMs).toBeDefined();

      sandbox.updateScenario({ temporaryUnavailability: true });
      const unavailHealth = await sandbox.getHealth();
      expect(unavailHealth.healthy).toBe(false);
      expect(unavailHealth.details?.reason).toBe('SIMULATED_TEMPORARY_UNAVAILABILITY');
    });

    it('handles disposal cleanly and rejects subsequent operations', async () => {
      await sandbox.dispose();
      const health = await sandbox.getHealth();
      expect(health.healthy).toBe(false);

      await expect(
        sandbox.initiateOutboundCall({
          callId: 'call-1',
          from: '+15550100',
          to: '+15550101',
        })
      ).rejects.toThrow(CarrierAdapterError);
    });
  });

  describe('Workstream D: Outbound Call Lifecycle Simulation', () => {
    it('initiates an outbound mock call and records active call tracking', async () => {
      const result = await sandbox.initiateOutboundCall({
        callId: 'call-outbound-1',
        from: '+15550100',
        to: '+15550101',
        direction: 'OUTBOUND',
      });

      expect(result.carrierCallId).toMatch(/^mock-carr-/);
      expect(result.status).toBe('initiated');
      expect(result.providerId).toBe('mock-carrier-sandbox');
      expect(sandbox.getActiveCallsCount()).toBe(1);
    });

    it('rejects initiation if destination phone number is empty', async () => {
      await expect(
        sandbox.initiateOutboundCall({
          callId: 'call-bad',
          from: '+15550100',
          to: '',
        })
      ).rejects.toThrow(CarrierInitiationFailedError);
    });

    it('terminates an active call idempotently and closes media sessions', async () => {
      const result = await sandbox.initiateOutboundCall({
        callId: 'call-term',
        from: '+15550100',
        to: '+15550101',
      });

      expect(sandbox.getActiveCallsCount()).toBe(1);
      await sandbox.terminateCall({ carrierCallId: result.carrierCallId, reason: 'USER_CANCELLED' });
      expect(sandbox.getActiveCallsCount()).toBe(0);

      // Repeated termination is safe and idempotent
      await expect(
        sandbox.terminateCall({ carrierCallId: result.carrierCallId })
      ).resolves.not.toThrow();
    });
  });

  describe('Workstream C: Inbound Call Lifecycle Simulation', () => {
    it('simulates an inbound call offer with synthetic phone numbers', () => {
      const { carrierCallId, offerEvent } = sandbox.simulateInboundCall({
        from: '+15550150',
        to: '+15550199',
        agentId: 'agent-123',
        organizationId: 'org-456',
      });

      expect(carrierCallId).toMatch(/^mock-inbound-/);
      expect(offerEvent.eventType).toBe('call.offered');
      expect(offerEvent.payload.from).toBe('+15550150');
      expect(offerEvent.payload.to).toBe('+15550199');
      expect(offerEvent.payload.agentId).toBe('agent-123');
      expect(offerEvent.payload.organizationId).toBe('org-456');
    });

    it('simulates call answer and disconnect for inbound calls', () => {
      const { carrierCallId } = sandbox.simulateInboundCall();
      expect(sandbox.getActiveCallsCount()).toBe(1);

      sandbox.simulateCallAnswer(carrierCallId);
      const events = sandbox.getEventLog();
      const answerEvt = events.find((e) => e.eventType === 'call.answered');
      expect(answerEvt).toBeDefined();

      sandbox.simulateCallDisconnect(carrierCallId);
      expect(sandbox.getActiveCallsCount()).toBe(0);
      const completedEvt = sandbox.getEventLog().find((e) => e.eventType === 'call.completed');
      expect(completedEvt).toBeDefined();
    });
  });

  describe('Workstream B: Normalized Event Parsing & Validation', () => {
    it('normalizes all canonical carrier event types cleanly', () => {
      const eventTypes = [
        { raw: 'call.offered', expected: 'call.offered' },
        { raw: 'call.initiated', expected: 'call.initiated' },
        { raw: 'call.ringing', expected: 'call.ringing' },
        { raw: 'call.answered', expected: 'call.answered' },
        { raw: 'media.requested', expected: 'media.requested' },
        { raw: 'media.connected', expected: 'media.connected' },
        { raw: 'media.disconnected', expected: 'media.disconnected' },
        { raw: 'call.completed', expected: 'call.completed' },
        { raw: 'call.failed', expected: 'call.failed' },
        { raw: 'call.rejected', expected: 'call.rejected' },
        { raw: 'call.busy', expected: 'call.busy' },
        { raw: 'call.unanswered', expected: 'call.unanswered' },
        { raw: 'call.cancelled', expected: 'call.cancelled' },
        { raw: 'transport.error', expected: 'transport.error' },
      ];

      for (const t of eventTypes) {
        const norm = sandbox.normalizeEvent({
          event: t.raw,
          carrierCallId: 'carr-test-1',
          callId: 'call-1',
          timestamp: 1700000000000,
          payload: { reason: 'test' },
        });

        expect(norm.eventType).toBe(t.expected);
        expect(norm.carrierCallId).toBe('carr-test-1');
        expect(norm.callId).toBe('call-1');
        expect(norm.timestamp).toBe(1700000000000);
      }
    });

    it('rejects invalid inputs without a non-null object', () => {
      expect(() => sandbox.normalizeEvent(null)).toThrow(InvalidCarrierEventError);
      expect(() => sandbox.normalizeEvent('string-payload')).toThrow(InvalidCarrierEventError);
      expect(() => sandbox.normalizeEvent(123)).toThrow(InvalidCarrierEventError);
    });

    it('rejects payloads missing carrierCallId', () => {
      expect(() =>
        sandbox.normalizeEvent({
          event: 'call.answered',
        })
      ).toThrow(InvalidCarrierEventError);
    });

    it('rejects payloads with unknown/unsupported event types', () => {
      expect(() =>
        sandbox.normalizeEvent({
          event: 'unknown.alien.event',
          carrierCallId: 'carr-1',
        })
      ).toThrow(InvalidCarrierEventError);
    });

    it('parses ISO date strings for timestamps cleanly', () => {
      const iso = '2026-10-27T10:00:00.000Z';
      const norm = sandbox.normalizeEvent({
        event: 'call.answered',
        carrierCallId: 'carr-iso',
        timestamp: iso,
      });

      expect(norm.timestamp).toBe(Date.parse(iso));
    });
  });

  describe('Workstream G: Deterministic Fault-Injection Scenarios', () => {
    it('forces outbound call initiation failure when configured', async () => {
      sandbox.updateScenario({
        forceInitiationFailure: true,
        forceInitiationFailureReason: 'INSUFFICIENT_CARRIER_TRUNKS',
      });

      await expect(
        sandbox.initiateOutboundCall({
          callId: 'call-fail',
          from: '+15550100',
          to: '+15550101',
        })
      ).rejects.toThrow(CarrierInitiationFailedError);
    });

    it('drops configured event types deterministically', async () => {
      sandbox.updateScenario({
        droppedEventTypes: ['call.ringing'],
      });

      const eventsReceived: string[] = [];
      sandbox.on('carrierEvent', (e) => eventsReceived.push(e.eventType));

      await sandbox.initiateOutboundCall({
        callId: 'call-drop',
        from: '+15550100',
        to: '+15550101',
      });

      // Wait a short moment for synchronous event emission
      await new Promise((r) => setTimeout(r, 60));

      expect(eventsReceived).toContain('call.initiated');
      expect(eventsReceived).not.toContain('call.ringing'); // Confirmed dropped
    });

    it('injects duplicate events when configured', async () => {
      sandbox.updateScenario({
        duplicateEvents: true,
      });

      const events: any[] = [];
      sandbox.on('carrierEvent', (e) => events.push(e));

      sandbox.simulateInboundCall();

      expect(events.length).toBe(2);
      expect(events[0].eventType).toBe('call.offered');
      expect(events[1].eventType).toBe('call.offered');
      expect(events[1].isDuplicate).toBe(true);
    });
  });

  describe('Workstream K: Future Distributed Nonce Store & Replay Protection', () => {
    it('atomically claims nonce and rejects duplicate replays in MemoryStreamTokenNonceStore', async () => {
      const store = new MemoryStreamTokenNonceStore();
      const nonce = 'test-nonce-123';
      const exp = Math.floor(Date.now() / 1000) + 60;

      const firstClaim = await store.claimNonce(nonce, exp);
      expect(firstClaim).toBe(true);

      // Replay attempt fails immediately
      const secondClaim = await store.claimNonce(nonce, exp);
      expect(secondClaim).toBe(false);
    });

    it('rejects expired nonces immediately', async () => {
      const store = new MemoryStreamTokenNonceStore();
      const expiredTime = Math.floor(Date.now() / 1000) - 10;

      const claim = await store.claimNonce('expired-nonce', expiredTime);
      expect(claim).toBe(false);
    });

    it('prunes expired nonces cleanly from the store', async () => {
      const store = new MemoryStreamTokenNonceStore();
      const past = Math.floor(Date.now() / 1000) - 5;
      const future = Math.floor(Date.now() / 1000) + 120;

      // Seed past nonces manually
      (store as any).nonces.set('old-1', past);
      (store as any).nonces.set('old-2', past);
      (store as any).nonces.set('valid-1', future);

      expect(store.size()).toBe(3);
      const pruned = await store.pruneExpired();
      expect(pruned).toBe(2);
      expect(store.size()).toBe(1);
    });

    it('integrates StreamTokenManager with IStreamTokenNonceStore', async () => {
      const store = new MemoryStreamTokenNonceStore();
      const manager = new StreamTokenManager({
        secret: 'test-secret-key-12345',
        nonceStore: store,
      });

      const { token } = manager.generateToken({
        callId: 'call-stream-1',
        organizationId: 'org-1',
      });

      const payload = await manager.verifyAndClaimTokenAsync(token, 'call-stream-1', 'org-1');
      expect(payload.callId).toBe('call-stream-1');

      // Replay must be rejected with StreamTokenReusedError
      await expect(
        manager.verifyAndClaimTokenAsync(token, 'call-stream-1', 'org-1')
      ).rejects.toThrow(StreamTokenReusedError);
    });
  });

  describe('Workstream L: Future Recovery Scheduler Contract & Harness', () => {
    it('executes bounded batch reconciliation deterministically', async () => {
      const mockReconciler = vi.fn().mockResolvedValue(['call-1', 'call-2']);
      const harness = new ManualRecoverySchedulerHarness(mockReconciler, {
        batchSize: 20,
        organizationId: 'org-test',
      });

      const result = await harness.triggerOnce();
      expect(result.reconciledCallIds).toEqual(['call-1', 'call-2']);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockReconciler).toHaveBeenCalledWith(20, 'org-test');
    });

    it('prevents overlapping recovery passes if a prior pass is in flight', async () => {
      let resolveSlowPass: () => void;
      const slowPassPromise = new Promise<string[]>((res) => {
        resolveSlowPass = () => res(['call-slow']);
      });

      const slowReconciler = vi.fn().mockImplementation(() => slowPassPromise);
      const harness = new ManualRecoverySchedulerHarness(slowReconciler);

      // Start pass 1 (in flight)
      const pass1Promise = harness.triggerOnce();

      // Attempt pass 2 while pass 1 is in flight
      const pass2Result = await harness.triggerOnce();
      expect(pass2Result.error).toBe('OVERLAPPING_EXECUTION_SKIPPED');
      expect(pass2Result.reconciledCallIds).toEqual([]);

      // Finish pass 1
      resolveSlowPass!();
      const pass1Result = await pass1Promise;
      expect(pass1Result.reconciledCallIds).toEqual(['call-slow']);
    });

    it('captures reconciler errors without crashing', async () => {
      const failingReconciler = vi.fn().mockRejectedValue(new Error('DATABASE_CONNECTION_LOST'));
      const harness = new ManualRecoverySchedulerHarness(failingReconciler);

      const result = await harness.triggerOnce();
      expect(result.error).toBe('DATABASE_CONNECTION_LOST');
      expect(result.reconciledCallIds).toEqual([]);
    });

    it('starts and stops scheduler cleanly', async () => {
      const harness = new ManualRecoverySchedulerHarness(async () => [], { intervalMs: 5000 });
      expect(harness.isRunning()).toBe(false);

      harness.start();
      expect(harness.isRunning()).toBe(true);

      await harness.stop();
      expect(harness.isRunning()).toBe(false);
    });
  });
});
