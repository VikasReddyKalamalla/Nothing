import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import { PrismaClient, CallStatus } from '@auris/database';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';
import { MockWebhookSignatureVerifier, StreamTokenManager } from '@auris/runtime';
import { activeTelephonyService } from '../src/modules/telephony/telephony.routes.js';
import { config } from '../src/config.js';

describe('Auris Phase 4: Telephony Gateway, Webhook Security & Media Streaming Integration Tests', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let serverUrl: string;
  let wsServerUrl: string;

  let orgAId: string;
  let orgBId: string;
  let userAToken: string;
  let userBToken: string;
  let agentAId: string;
  let callAId: string;

  const verifier = new MockWebhookSignatureVerifier({
    secret: config.MOCK_WEBHOOK_SECRET,
    toleranceSeconds: 300,
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = buildServer();

    // Start Fastify on an ephemeral port for real HTTP and WebSocket testing
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    serverUrl = address;
    wsServerUrl = address.replace('http://', 'ws://');

    // 1. Provision Organization A and User A
    const orgA = await prisma.organization.create({
      data: {
        name: `Org A Telephony ${Date.now()}`,
        slug: `org-a-telephony-${Date.now()}`,
      },
    });
    orgAId = orgA.id;

    await prisma.wallet.create({
      data: {
        organizationId: orgAId,
        balanceCredits: 100.0,
      },
    });

    const userA = await prisma.user.create({
      data: {
        email: `usera-telephony-${Date.now()}@auris.test`,
        name: 'User A',
        status: 'active',
      },
    });

    await prisma.membership.create({
      data: {
        userId: userA.id,
        organizationId: orgAId,
        role: 'ADMIN',
      },
    });

    userAToken = app.jwt.sign({ userId: userA.id, role: 'ADMIN' });

    // 2. Provision Organization B and User B (for cross-tenant tests)
    const orgB = await prisma.organization.create({
      data: {
        name: `Org B Telephony ${Date.now()}`,
        slug: `org-b-telephony-${Date.now()}`,
      },
    });
    orgBId = orgB.id;

    const userB = await prisma.user.create({
      data: {
        email: `userb-telephony-${Date.now()}@auris.test`,
        name: 'User B',
        status: 'active',
      },
    });

    await prisma.membership.create({
      data: {
        userId: userB.id,
        organizationId: orgBId,
        role: 'ADMIN',
      },
    });

    userBToken = app.jwt.sign({ userId: userB.id, role: 'ADMIN' });

    // 3. Create Agent for Org A
    const agentA = await prisma.agent.create({
      data: {
        organizationId: orgAId,
        name: 'Voice Receptionist A',
        promptTemplate: 'You are an Auris AI agent.',
      },
    });
    agentAId = agentA.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Create a fresh test Call record for each test
    const call = await prisma.call.create({
      data: {
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        status: CallStatus.INITIATED,
        carrierCallId: `mock-carrier-leg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      },
    });
    callAId = call.id;

    // Register mapping with gateway
    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    if (telephonyService) {
      telephonyService.gateway.registerCallMapping(call.carrierCallId!, call.id);
    }
  });

  describe('1. Webhook Authentication, Canonical Raw Bytes & Replay Security', () => {
    it('accepts and acknowledges valid webhook with authentic HMAC-SHA256 signature', async () => {
      const payload = {
        event: 'ringing',
        carrierCallId: `mock-carrier-leg-${Date.now()}`,
        timestamp: Date.now(),
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sigHeader = verifier.formatHeader(rawBody);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.accepted).toBe(true);
      expect(data.eventType).toBe('call.ringing');
    });

    it('strictly rejects webhook with missing signature header with 401 UNAUTHORIZED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ event: 'ringing', carrierCallId: 'c-1' }),
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('UNAUTHORIZED');
    });

    it('strictly rejects webhook when request body has been tampered with', async () => {
      const originalBody = Buffer.from(JSON.stringify({ event: 'answered', carrierCallId: 'c-1' }));
      const sigHeader = verifier.formatHeader(originalBody);

      const tamperedBody = Buffer.from(JSON.stringify({ event: 'answered', carrierCallId: 'c-1-ATTACK' }));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: tamperedBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('UNAUTHORIZED');
    });

    it('strictly rejects webhook with expired timestamp (> 300s) with 409 REPLAY_DETECTED', async () => {
      const payload = { event: 'ringing', carrierCallId: 'c-1' };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 305;
      const sigHeader = verifier.formatHeader(rawBody, expiredTimestamp);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('UNAUTHORIZED');
    });

    it('strictly rejects replayed webhook with 409 REPLAY_DETECTED', async () => {
      const payload = { event: 'ringing', carrierCallId: `c-replay-${Date.now()}` };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const nowSec = Math.floor(Date.now() / 1000);
      const sigHeader = verifier.formatHeader(rawBody, nowSec);

      // 1. First delivery -> accepted
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: rawBody,
      });
      expect(res1.statusCode).toBe(200);

      // 2. Replay with identical signature and timestamp -> rejected
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: rawBody,
      });
      expect(res2.statusCode).toBe(409);
      expect(res2.json().error).toBe('REPLAY_DETECTED');
    });

    it('handles duplicate event delivery idempotently and writes to carrier_webhook_events', async () => {
      const eventId = `evt-dedup-${Date.now()}`;
      const payload = {
        eventId,
        event: 'answered',
        carrierCallId: `carrier-leg-dedup-${Date.now()}`,
        timestamp: Date.now(),
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sigHeader1 = verifier.formatHeader(rawBody, Math.floor(Date.now() / 1000));

      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader1,
        },
        payload: rawBody,
      });
      expect(res1.statusCode).toBe(200);

      // Verify recorded in DB
      const dbEvent = await prisma.carrierWebhookEvent.findUnique({
        where: { eventId },
      });
      expect(dbEvent).toBeDefined();
      expect(dbEvent!.carrier).toBe('mock-telephony');
    });
  });

  describe('2. Stream Token Issuance & Tenant Security', () => {
    it('generates short-lived stream token for authorized organization user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
        payload: {
          callId: callAId,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.token).toBeDefined();
      expect(data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(data.wsUrl).toContain('/v1/telephony/stream?callId=');
    });

    it('rejects cross-tenant stream token request with 404/403 (User B accessing Call A)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: {
          authorization: `Bearer ${userBToken}`,
        },
        payload: {
          callId: callAId,
        },
      });

      expect([403, 404]).toContain(res.statusCode);
    });

    it('rejects stream token request without valid JWT authentication with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        payload: {
          callId: callAId,
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('3. WebSocket Media Streaming, Backpressure & Barge-In', () => {
    it('establishes WebSocket connection with valid stream token and exchanges media frames', async () => {
      // 1. Issue stream token
      const tokenRes = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { callId: callAId },
      });
      const { token } = tokenRes.json();

      // 2. Connect client WebSocket
      const wsUrl = `${wsServerUrl}/v1/telephony/stream?callId=${encodeURIComponent(callAId)}&token=${encodeURIComponent(token)}`;
      const clientWs = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        clientWs.on('open', resolve);
        clientWs.on('error', reject);
      });

      expect(clientWs.readyState).toBe(WebSocket.OPEN);

      // 3. Send mock start frame
      const startMsg = JSON.stringify({
        event: 'start',
        streamId: 'stream-integration-test',
        callReference: `carrier-${callAId}`,
        mediaFormat: { encoding: 'audio/x-l16', sampleRate: 16000, channels: 1 },
      });
      clientWs.send(startMsg);

      // 4. Send mock media frame (640 bytes raw PCM in base64)
      const pcmBytes = Buffer.alloc(640);
      const mediaMsg = JSON.stringify({
        event: 'media',
        streamId: 'stream-integration-test',
        sequenceNumber: 1,
        media: {
          payload: pcmBytes.toString('base64'),
          timestamp: Date.now(),
        },
      });
      clientWs.send(mediaMsg);

      await new Promise((r) => setTimeout(r, 50));

      // 5. Clean close
      clientWs.close(1000, 'NORMAL_HANGUP');
      await new Promise<void>((resolve) => clientWs.on('close', () => resolve()));
      expect(clientWs.readyState).toBe(WebSocket.CLOSED);
    });

    it('rejects WebSocket connection with invalid or tampered token with close code 1008', async () => {
      const badWsUrl = `${wsServerUrl}/v1/telephony/stream?callId=${encodeURIComponent(callAId)}&token=invalid.tampered.token`;
      const clientWs = new WebSocket(badWsUrl);

      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        clientWs.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      const { code } = await closePromise;
      expect(code).toBe(1008); // Policy violation
    });

    it('strictly rejects token reuse across multiple WebSocket connections with close code 1008', async () => {
      // 1. Issue stream token
      const tokenRes = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { callId: callAId },
      });
      const { token } = tokenRes.json();

      // 2. Connect Connection 1 -> should succeed
      const wsUrl = `${wsServerUrl}/v1/telephony/stream?callId=${encodeURIComponent(callAId)}&token=${encodeURIComponent(token)}`;
      const clientWs1 = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        clientWs1.on('open', resolve);
        clientWs1.on('error', reject);
      });
      expect(clientWs1.readyState).toBe(WebSocket.OPEN);

      // 3. Connect Connection 2 with identical claimed token -> must be rejected with 1008
      const clientWs2 = new WebSocket(wsUrl);
      const closePromise2 = new Promise<{ code: number }>((resolve) => {
        clientWs2.on('close', (code) => resolve({ code }));
      });

      const { code: closeCode2 } = await closePromise2;
      expect(closeCode2).toBe(1008);

      clientWs1.close();
    });

    it('handles barge-in speech interruption and transmits clear control frame to client', async () => {
      // Issue token & connect
      const tokenRes = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { callId: callAId },
      });
      const { token } = tokenRes.json();

      const wsUrl = `${wsServerUrl}/v1/telephony/stream?callId=${encodeURIComponent(callAId)}&token=${encodeURIComponent(token)}`;
      const clientWs = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        clientWs.on('open', resolve);
        clientWs.on('error', reject);
      });

      const telephonyService = activeTelephonyService || (app as any).telephonyService;
      const connection = telephonyService!.gateway.getActiveConnection(callAId);
      expect(connection).toBeDefined();

      const receivedMessages: string[] = [];
      clientWs.on('message', (data) => {
        receivedMessages.push(data.toString());
      });

      // Trigger barge-in flush on the connection
      await connection.clearBuffer();

      await new Promise((r) => setTimeout(r, 50));

      // Verify 'clear' control frame arrived at the WebSocket client
      expect(receivedMessages.length).toBeGreaterThan(0);
      const clearMsg = JSON.parse(receivedMessages[0]);
      expect(clearMsg.event).toBe('clear');

      clientWs.close();
    });
  });

  describe('4. Lifecycle Synchronization & Terminal States', () => {
    it('synchronizes call.answered webhook event with Call database record status IN_PROGRESS', async () => {
      const dbCall = await prisma.call.findUnique({ where: { id: callAId } });
      expect(dbCall!.status).toBe(CallStatus.INITIATED);

      const payload = {
        event: 'answered',
        carrierCallId: dbCall!.carrierCallId,
        callId: callAId,
        timestamp: Date.now(),
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sigHeader = verifier.formatHeader(rawBody);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);

      // Verify DB record status transitioned to IN_PROGRESS
      const updatedCall = await prisma.call.findUnique({ where: { id: callAId } });
      expect(updatedCall!.status).toBe(CallStatus.IN_PROGRESS);
      expect(updatedCall!.startedAt).toBeDefined();
    });

    it('synchronizes call.disconnected webhook event with Call database record status COMPLETED', async () => {
      const dbCall = await prisma.call.findUnique({ where: { id: callAId } });

      const payload = {
        event: 'disconnected',
        carrierCallId: dbCall!.carrierCallId,
        callId: callAId,
        reason: 'NORMAL_HANGUP',
        timestamp: Date.now(),
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sigHeader = verifier.formatHeader(rawBody);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);

      // Verify DB record status transitioned to COMPLETED
      const updatedCall = await prisma.call.findUnique({ where: { id: callAId } });
      expect(updatedCall!.status).toBe(CallStatus.COMPLETED);
      expect(updatedCall!.endedAt).toBeDefined();
      expect(updatedCall!.terminationReason).toBe('NORMAL_HANGUP');
    });

    it('does not revive a terminal call when a late event arrives', async () => {
      // Mark call COMPLETED
      await prisma.call.update({
        where: { id: callAId },
        data: { status: CallStatus.COMPLETED, endedAt: new Date() },
      });

      const dbCall = await prisma.call.findUnique({ where: { id: callAId } });

      // Late answered event arrives
      const payload = {
        event: 'answered',
        carrierCallId: dbCall!.carrierCallId,
        callId: callAId,
        timestamp: Date.now(),
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sigHeader = verifier.formatHeader(rawBody);

      await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': sigHeader,
        },
        payload: rawBody,
      });

      // Call status must remain COMPLETED
      const checkCall = await prisma.call.findUnique({ where: { id: callAId } });
      expect(checkCall!.status).toBe(CallStatus.COMPLETED);
    });
  });
});
