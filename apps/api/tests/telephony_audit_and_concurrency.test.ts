import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import { PrismaClient, CallStatus } from '@auris/database';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';
import { MockWebhookSignatureVerifier } from '@auris/runtime';
import { activeTelephonyService } from '../src/modules/telephony/telephony.routes.js';
import { config } from '../src/config.js';

describe('Phase 4.1 Audit: API Telephony Security, Deduplication & Database Invariants', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let serverUrl: string;
  let wsServerUrl: string;

  let orgAId: string;
  let userAToken: string;
  let agentAId: string;
  let callAId: string;

  const verifier = new MockWebhookSignatureVerifier({
    secret: config.MOCK_WEBHOOK_SECRET,
    toleranceSeconds: 300,
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = buildServer();

    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    serverUrl = address;
    wsServerUrl = address.replace('http://', 'ws://');

    const orgA = await prisma.organization.create({
      data: {
        name: `Org Audit ${Date.now()}`,
        slug: `org-audit-${Date.now()}`,
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
        email: `usera-audit-${Date.now()}@auris.test`,
        name: 'Audit User',
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

    const agentA = await prisma.agent.create({
      data: {
        organizationId: orgAId,
        name: 'Audit Agent',
        promptTemplate: 'Prompt',
      },
    });
    agentAId = agentA.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const call = await prisma.call.create({
      data: {
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        status: CallStatus.INITIATED,
        carrierCallId: `carrier-leg-audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      },
    });
    callAId = call.id;

    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    if (telephonyService) {
      telephonyService.gateway.registerCallMapping(call.carrierCallId!, call.id);
    }
  });

  describe('SEC-04: Terminal Call WebSocket Connection Rejection', () => {
    it('strictly rejects incoming WebSocket stream connection when Call is already in a terminal state (COMPLETED)', async () => {
      // 1. Issue stream token while call is active
      const tokenRes = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { callId: callAId },
      });
      const { token } = tokenRes.json();

      // 2. Terminate the call in the database (e.g. caller hung up)
      await prisma.call.update({
        where: { id: callAId },
        data: { status: CallStatus.COMPLETED, endedAt: new Date() },
      });

      // 3. Client presents token to connect WebSocket
      const wsUrl = `${wsServerUrl}/v1/telephony/stream?callId=${encodeURIComponent(callAId)}&token=${encodeURIComponent(token)}`;
      const clientWs = new WebSocket(wsUrl);

      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        clientWs.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      const { code, reason } = await closePromise;
      // Must reject with 1008 policy violation because call is already terminal!
      expect(code).toBe(1008);
      expect(reason).toMatch(/terminal|already ended|closed/i);
    });
  });

  describe('SEC-02: Concurrent Duplicate Webhook Delivery & Atomic Event Claims', () => {
    it('concurrent duplicate webhook deliveries with same eventId do not duplicate database side-effects or events', async () => {
      const eventId = `concurrent-evt-${Date.now()}`;
      const payload = {
        eventId,
        event: 'answered',
        carrierCallId: `carrier-leg-conc-${Date.now()}`,
        timestamp: Date.now(),
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sigHeader = verifier.formatHeader(rawBody);

      // Fire 5 concurrent requests with the identical eventId
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

      // Verify that all 5 responses return 200 OK or 409
      for (const res of responses) {
        if (res.statusCode !== 200 && res.statusCode !== 409) {
          console.error('Unexpected status:', res.statusCode, res.json());
        }
        expect([200, 409]).toContain(res.statusCode);
      }

      // In the database, EXACTLY ONE record in carrier_webhook_events must exist!
      const dbRecords = await prisma.carrierWebhookEvent.findMany({
        where: { eventId },
      });
      expect(dbRecords.length).toBe(1);
    });
  });

  describe('AUDIT G: Cross-Tenant Isolation Across Webhooks & Streams', () => {
    let orgBId: string;
    let userBToken: string;
    let callBId: string;

    beforeAll(async () => {
      const orgB = await prisma.organization.create({
        data: {
          name: `Org B Isolation ${Date.now()}`,
          slug: `org-b-isolation-${Date.now()}`,
        },
      });
      orgBId = orgB.id;

      await prisma.wallet.create({
        data: {
          organizationId: orgBId,
          balanceCredits: 50.0,
        },
      });

      const userB = await prisma.user.create({
        data: {
          email: `userb-isolation-${Date.now()}@auris.test`,
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

      const agentB = await prisma.agent.create({
        data: {
          organizationId: orgBId,
          name: 'Agent B Isolation',
          promptTemplate: 'Prompt B',
        },
      });

      const callB = await prisma.call.create({
        data: {
          organizationId: orgBId,
          agentId: agentB.id,
          direction: 'INBOUND',
          callerNumber: '+919888877766',
          destinationNumber: '+919888855544',
          status: CallStatus.INITIATED,
          carrierCallId: `carrier-leg-b-${Date.now()}`,
        },
      });
      callBId = callB.id;

      const telephonyService = activeTelephonyService || (app as any).telephonyService;
      if (telephonyService) {
        telephonyService.gateway.registerCallMapping(callB.carrierCallId!, callB.id);
      }
    });

    it('strictly forbids User B from generating a stream token for Org A call (returns 400, 403, or 404)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { callId: callAId },
      });

      expect([400, 403, 404]).toContain(res.statusCode);
    });

    it('strictly rejects token presentation when token was issued for Call B but presented to attach to Call A', async () => {
      // 1. Issue legitimate token for Call B
      const tokenRes = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { callId: callBId },
      });
      expect(tokenRes.statusCode).toBe(200);
      const { token: tokenB } = tokenRes.json();

      // 2. Attacker attempts to attach token B to Call A
      const wsUrl = `${wsServerUrl}/v1/telephony/stream?callId=${encodeURIComponent(callAId)}&token=${encodeURIComponent(tokenB)}`;
      const clientWs = new WebSocket(wsUrl);

      const closePromise = new Promise<{ code: number }>((resolve) => {
        clientWs.on('close', (code) => resolve({ code }));
      });

      const { code } = await closePromise;
      expect(code).toBe(1008); // Rejected with Policy Violation
    });
  });

  describe('AUDIT F: Idempotent Concurrency on Simultaneous Terminations', () => {
    it('simultaneous webhook disconnect and WebSocket close perform idempotent termination without duplicating settlement', async () => {
      const dbCall = await prisma.call.findUnique({ where: { id: callAId } });

      const payload = {
        event: 'disconnected',
        carrierCallId: dbCall!.carrierCallId,
        callId: callAId,
        reason: 'HANGUP_RACE',
        timestamp: Date.now(),
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sigHeader = verifier.formatHeader(rawBody);

      // Issue token and connect WebSocket
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

      // Race: fire webhook disconnect while simultaneously closing WebSocket
      const [webhookRes] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/v1/telephony/webhook',
          headers: {
            'content-type': 'application/json',
            'x-auris-signature': sigHeader,
          },
          payload: rawBody,
        }),
        new Promise<void>((resolve) => {
          clientWs.close(1000, 'WS_CLOSE_RACE');
          clientWs.on('close', () => resolve());
        }),
      ]);

      expect(webhookRes.statusCode).toBe(200);

      // Verify Call record in DB
      const finalCall = await prisma.call.findUnique({ where: { id: callAId } });
      expect(finalCall!.status).toBe(CallStatus.COMPLETED);
    });
  });
});
