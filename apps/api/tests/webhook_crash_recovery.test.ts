import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { PrismaClient, CallStatus } from '@auris/database';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';
import { MockWebhookSignatureVerifier } from '@auris/runtime';
import { activeTelephonyService } from '../src/modules/telephony/telephony.routes.js';
import { config } from '../src/config.js';

describe('Phase 4.1.1: Webhook Crash-Recovery & Transaction Boundary Audit', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let orgId: string;
  let agentId: string;
  let callId: string;
  let carrierCallId: string;

  const verifier = new MockWebhookSignatureVerifier({
    secret: config.MOCK_WEBHOOK_SECRET,
    toleranceSeconds: 300,
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });

    const org = await prisma.organization.create({
      data: {
        name: `Crash Recovery Org ${Date.now()}`,
        slug: `crash-recovery-org-${Date.now()}`,
      },
    });
    orgId = org.id;

    const agent = await prisma.agent.create({
      data: {
        organizationId: orgId,
        name: 'Crash Agent',
        promptTemplate: 'Prompt',
      },
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    carrierCallId = `carrier-leg-crash-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const call = await prisma.call.create({
      data: {
        organizationId: orgId,
        agentId: agentId,
        direction: 'INBOUND',
        callerNumber: '+919900112233',
        destinationNumber: '+919900445566',
        status: CallStatus.INITIATED,
        carrierCallId,
      },
    });
    callId = call.id;

    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    if (telephonyService) {
      telephonyService.gateway.registerCallMapping(carrierCallId, callId);
    }
  });

  it('1. Atomic Transaction Rollback: Database error during effect application rolls back CarrierWebhookEvent so retry cleanly succeeds', async () => {
    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    expect(telephonyService).toBeDefined();

    const eventId = `tx-rollback-evt-${Date.now()}`;
    const payload = {
      eventId,
      event: 'disconnected',
      carrierCallId,
      timestamp: Math.floor(Date.now() / 1000),
      reason: 'CARRIER_DISCONNECT',
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sigHeader = verifier.formatHeader(rawBody);

    // Fault Injection: Make syncCallStatus fail during transaction on first attempt
    const originalSync = telephonyService['syncCallStatus'].bind(telephonyService);
    let injectionCount = 0;
    telephonyService['syncCallStatus'] = async (cId: string, evt: any, client: any) => {
      if (injectionCount === 0) {
        injectionCount++;
        throw new Error('SIMULATED_TRANSACTION_FAILURE_DURING_CALL_UPDATE');
      }
      return originalSync(cId, evt, client);
    };

    // First attempt fails inside $transaction
    let firstAttemptError: any = null;
    try {
      await telephonyService.handleWebhook(rawBody, {
        'content-type': 'application/json',
        'x-auris-signature': sigHeader,
      });
    } catch (err: any) {
      firstAttemptError = err;
    }

    expect(firstAttemptError).toBeDefined();
    expect(firstAttemptError.message).toBe('SIMULATED_TRANSACTION_FAILURE_DURING_CALL_UPDATE');

    // VERIFY TRANSACTION ROLLBACK:
    // CarrierWebhookEvent was NOT committed because the transaction rolled back!
    const dbEventAfterRollback = await prisma.carrierWebhookEvent.findUnique({
      where: { eventId },
    });
    expect(dbEventAfterRollback).toBeNull();

    // Call status remains INITIATED
    const callAfterRollback = await prisma.call.findUnique({ where: { id: callId } });
    expect(callAfterRollback?.status).toBe(CallStatus.INITIATED);

    // RETRY: Carrier retries delivery
    const retryPayload = {
      ...payload,
      timestamp: Math.floor(Date.now() / 1000) + 1,
    };
    const retryBody = Buffer.from(JSON.stringify(retryPayload));
    const retrySigHeader = verifier.formatHeader(retryBody);

    const retryResult = await telephonyService.handleWebhook(retryBody, {
      'content-type': 'application/json',
      'x-auris-signature': retrySigHeader,
    });

    expect(retryResult.accepted).toBe(true);
    expect(retryResult.duplicate).toBe(false);

    // VERIFY SUCCESSFUL RECOVERY:
    // 1. CarrierWebhookEvent is now durably stored
    const finalEvent = await prisma.carrierWebhookEvent.findUnique({ where: { eventId } });
    expect(finalEvent).not.toBeNull();

    // 2. Call status is successfully COMPLETED
    const finalCall = await prisma.call.findUnique({ where: { id: callId } });
    expect(finalCall?.status).toBe(CallStatus.COMPLETED);
    expect(finalCall?.endedAt).not.toBeNull();

    // Restore original method
    telephonyService['syncCallStatus'] = originalSync;
  });

  it('2. Idempotent Effect Recovery: If CarrierWebhookEvent exists prior to effect completion, retry recovers call state', async () => {
    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    expect(telephonyService).toBeDefined();

    const eventId = `partial-write-evt-${Date.now()}`;
    const payload = {
      eventId,
      event: 'disconnected',
      carrierCallId,
      timestamp: Math.floor(Date.now() / 1000),
      reason: 'CLIENT_HANGUP',
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sigHeader = verifier.formatHeader(rawBody);

    // Simulate crash after partial write by inserting CarrierWebhookEvent directly into DB
    // while leaving Call.status as INITIATED
    await prisma.carrierWebhookEvent.create({
      data: {
        eventId,
        carrier: 'mock-telephony',
        eventType: 'call.disconnected',
        payloadHash: 'simulated_raw_hash',
      },
    });

    const callBeforeRetry = await prisma.call.findUnique({ where: { id: callId } });
    expect(callBeforeRetry?.status).toBe(CallStatus.INITIATED);

    // Carrier retries delivery (with fresh timestamp)
    const retryPayload = {
      ...payload,
      timestamp: Math.floor(Date.now() / 1000) + 1,
    };
    const retryBody = Buffer.from(JSON.stringify(retryPayload));
    const retrySigHeader = verifier.formatHeader(retryBody);

    const retryResult = await telephonyService.handleWebhook(retryBody, {
      'content-type': 'application/json',
      'x-auris-signature': retrySigHeader,
    });

    // Marked duplicate: true because eventId already existed
    expect(retryResult.duplicate).toBe(true);
    expect(retryResult.accepted).toBe(true);

    // VERIFY RECOVERY: The call state was recovered to COMPLETED!
    const callAfterRecovery = await prisma.call.findUnique({ where: { id: callId } });
    expect(callAfterRecovery?.status).toBe(CallStatus.COMPLETED);
    expect(callAfterRecovery?.terminationReason).toBe('CLIENT_HANGUP');
  });

  it('3. Process Restart Hydration: When memory is cleared, webhook resolves callId via PostgreSQL carrierCallId', async () => {
    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    expect(telephonyService).toBeDefined();

    // Simulate process cold restart: wipe in-memory providerCallMap completely
    telephonyService.gateway.unregisterCallMapping(carrierCallId);
    expect(telephonyService.gateway.getCallMapping(carrierCallId)).toBeUndefined();

    const eventId = `cold-restart-evt-${Date.now()}`;
    const payload = {
      eventId,
      event: 'disconnected',
      carrierCallId,
      timestamp: Math.floor(Date.now() / 1000),
      reason: 'RESTART_RECOVERY_HANGUP',
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sigHeader = verifier.formatHeader(rawBody);

    const result = await telephonyService.handleWebhook(rawBody, {
      'content-type': 'application/json',
      'x-auris-signature': sigHeader,
    });

    expect(result.accepted).toBe(true);
    expect(result.callId).toBe(callId);

    // Verified: in-memory gateway mapping was re-hydrated from PostgreSQL!
    expect(telephonyService.gateway.getCallMapping(carrierCallId)).toBe(callId);

    // Verified: Call status was updated to COMPLETED!
    const finalCall = await prisma.call.findUnique({ where: { id: callId } });
    expect(finalCall?.status).toBe(CallStatus.COMPLETED);
  });

  it('4. Concurrent Duplicate Deliveries: 5 concurrent requests with same eventId produce exactly 1 DB record and no duplicate effects', async () => {
    const eventId = `concurrent-tx-evt-${Date.now()}`;
    const payload = {
      eventId,
      event: 'answered',
      carrierCallId,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sigHeader = verifier.formatHeader(rawBody);

    // Fire 5 concurrent requests with identical raw body and signature
    const requests = Array.from({ length: 5 }).map(() =>
      app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: rawBody,
      })
    );

    const responses = await Promise.all(requests);

    // All 5 requests must return 200 OK or 409
    for (const res of responses) {
      expect([200, 409]).toContain(res.statusCode);
    }

    // Exactly 1 record exists in carrier_webhook_events
    const eventRecords = await prisma.carrierWebhookEvent.findMany({
      where: { eventId },
    });
    expect(eventRecords.length).toBe(1);

    // Call status is cleanly IN_PROGRESS
    const finalCall = await prisma.call.findUnique({ where: { id: callId } });
    expect(finalCall?.status).toBe(CallStatus.IN_PROGRESS);
  });

  it('5. WebSocket Media Gating: Strict rejection of media on unauthorized or terminal call before audio processing', async () => {
    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    expect(telephonyService).toBeDefined();

    // 1. Issue token for callId
    const tokenRes = await telephonyService.generateStreamToken({
      callId,
      organizationId: orgId,
    });
    const token = tokenRes.token;

    // 2. Mark call COMPLETED in the database before connection
    await prisma.call.update({
      where: { id: callId },
      data: { status: CallStatus.COMPLETED, endedAt: new Date() },
    });

    // 3. Connect client WebSocket and attempt to send audio frame immediately
    const wsUrl = `ws://127.0.0.1:${(app.server.address() as any).port}/v1/telephony/stream?callId=${encodeURIComponent(callId)}&token=${encodeURIComponent(token)}`;
    const WebSocket = (await import('ws')).default;
    const clientWs = new WebSocket(wsUrl);

    let frameSent = false;
    let closeCode = 0;

    const closePromise = new Promise<{ code: number }>((resolve) => {
      clientWs.on('close', (code) => {
        closeCode = code;
        resolve({ code });
      });
      clientWs.on('open', () => {
        // Attempt to send audio frame immediately upon socket open
        try {
          const mediaMsg = JSON.stringify({
            event: 'media',
            streamId: 'unauthorized-stream',
            sequenceNumber: 1,
            media: {
              payload: Buffer.alloc(640).toString('base64'),
              timestamp: Date.now(),
            },
          });
          clientWs.send(mediaMsg);
          frameSent = true;
        } catch {}
      });
    });

    await closePromise;

    // Must be rejected with 1008 policy violation
    expect(closeCode).toBe(1008);

    // Active connections must NOT retain the closed session
    expect(telephonyService.gateway.getActiveConnection(callId)).toBeUndefined();
  });
});
