import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import { PrismaClient, CallStatus } from '@auris/database';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';
import {
  MockWebhookSignatureVerifier,
  MockCarrierSandbox,
  G711MuLawCodec,
  StreamTokenManager,
  MemoryStreamTokenNonceStore,
} from '@auris/runtime';
import { activeTelephonyService } from '../src/modules/telephony/telephony.routes.js';
import { config } from '../src/config.js';

describe('Auris Phase 4.2: Carrier Adapter Framework, Mock Telephony Sandbox & Resilience Tests', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let serverUrl: string;
  let wsServerUrl: string;

  let orgAId: string;
  let orgBId: string;
  let userAToken: string;
  let userBToken: string;
  let agentAId: string;

  let sandbox: MockCarrierSandbox;
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

    // Provision Org A & User A
    const orgA = await prisma.organization.create({
      data: {
        name: `Org A Sandbox ${Date.now()}`,
        slug: `org-a-sandbox-${Date.now()}`,
      },
    });
    orgAId = orgA.id;

    await prisma.wallet.create({
      data: {
        organizationId: orgAId,
        balanceCredits: 50.0,
      },
    });

    const userA = await prisma.user.create({
      data: {
        email: `usera-sandbox-${Date.now()}@auris.test`,
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

    // Provision Org B & User B (Cross-tenant boundary)
    const orgB = await prisma.organization.create({
      data: {
        name: `Org B Sandbox ${Date.now()}`,
        slug: `org-b-sandbox-${Date.now()}`,
      },
    });
    orgBId = orgB.id;

    const userB = await prisma.user.create({
      data: {
        email: `userb-sandbox-${Date.now()}@auris.test`,
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

    // Create Agent for Org A
    const agentA = await prisma.agent.create({
      data: {
        organizationId: orgAId,
        name: 'Sandbox Agent A',
        promptTemplate: 'You are an Auris AI voice agent workforce representative.',
      },
    });
    agentAId = agentA.id;

    sandbox = new MockCarrierSandbox();
  });

  afterAll(async () => {
    await sandbox.dispose();
    await app.close();
    await prisma.$disconnect();
  });

  describe('Workstream C & D: Mock Inbound & Outbound Call Lifecycles', () => {
    it('executes a complete billable outbound call flow through sandbox simulation', async () => {
      // 1. Outbound call requested & initiated
      const carrierCallRef = `carr-out-${Date.now()}`;
      const call = await prisma.call.create({
        data: {
          organizationId: orgAId,
          agentId: agentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+15550100',
          destinationNumber: '+15550101',
          status: CallStatus.INITIATED,
          carrierCallId: carrierCallRef,
        },
      });

      const telephonyService = (app as any).telephonyService || activeTelephonyService;
      telephonyService.gateway.registerCallMapping(carrierCallRef, call.id);

      // Pre-auth wallet hold
      await telephonyService.walletService.createReservation({
        organizationId: orgAId,
        callId: call.id,
        amountCredits: 6.0,
      });

      const walletBefore = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgAId } });
      expect(Number(walletBefore.reservedCredits)).toBe(6.0);

      // 2. Carrier Ringing Webhook
      const ringingPayload = {
        event: 'ringing',
        carrierCallId: carrierCallRef,
        timestamp: Date.now(),
      };
      const rawRinging = Buffer.from(JSON.stringify(ringingPayload));
      const resRinging = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': verifier.formatHeader(rawRinging),
        },
        payload: rawRinging,
      });
      expect(resRinging.statusCode).toBe(200);

      // 3. Carrier Answered Webhook
      const answeredPayload = {
        event: 'answered',
        carrierCallId: carrierCallRef,
        timestamp: Date.now(),
      };
      const rawAnswered = Buffer.from(JSON.stringify(answeredPayload));
      const resAnswered = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': verifier.formatHeader(rawAnswered),
        },
        payload: rawAnswered,
      });
      expect(resAnswered.statusCode).toBe(200);

      const dbCallAnswered = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
      expect(dbCallAnswered.status).toBe(CallStatus.IN_PROGRESS);

      // 4. Carrier Disconnected / Completed Webhook (with 45 seconds duration)
      const disconnectedPayload = {
        eventId: `disc-evt-${Date.now()}`,
        event: 'disconnected',
        carrierCallId: carrierCallRef,
        timestamp: Date.now(),
        reason: 'CALLER_HUNG_UP',
      };
      // Manually set duration on call to simulate 45 billable seconds
      await prisma.call.update({
        where: { id: call.id },
        data: { durationSeconds: 45 },
      });

      const rawDisconnected = Buffer.from(JSON.stringify(disconnectedPayload));
      const resDisconnected = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': verifier.formatHeader(rawDisconnected),
        },
        payload: rawDisconnected,
      });
      expect(resDisconnected.statusCode).toBe(200);

      const dbCallCompleted = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
      expect(dbCallCompleted.status).toBe(CallStatus.COMPLETED);

      // Verify wallet settlement: 45s rounds up to 60s @ 6.0/min -> exactly 6.0 credits deducted
      const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgAId } });
      expect(Number(walletAfter.balanceCredits)).toBe(44.0);
      expect(Number(walletAfter.reservedCredits)).toBe(0.0);

      const reservation = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      expect(reservation.status).toBe('SETTLED');
    });

    it('releases pre-auth hold without charges when call is unanswered or cancelled', async () => {
      const carrierCallRef = `carr-unans-${Date.now()}`;
      const call = await prisma.call.create({
        data: {
          organizationId: orgAId,
          agentId: agentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+15550100',
          destinationNumber: '+15550102',
          status: CallStatus.INITIATED,
          carrierCallId: carrierCallRef,
        },
      });

      const telephonyService = (app as any).telephonyService || activeTelephonyService;
      telephonyService.gateway.registerCallMapping(carrierCallRef, call.id);

      await telephonyService.walletService.createReservation({
        organizationId: orgAId,
        callId: call.id,
        amountCredits: 6.0,
      });

      const walletBefore = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgAId } });
      expect(Number(walletBefore.reservedCredits)).toBe(6.0);

      // Disconnect without being answered
      const discPayload = {
        eventId: `disc-unans-${Date.now()}`,
        event: 'disconnected',
        carrierCallId: carrierCallRef,
        reason: 'NO_ANSWER',
        timestamp: Date.now(),
      };
      const rawDisc = Buffer.from(JSON.stringify(discPayload));
      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': verifier.formatHeader(rawDisc),
        },
        payload: rawDisc,
      });
      expect(res.statusCode).toBe(200);

      // Verify full release
      const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgAId } });
      expect(Number(walletAfter.reservedCredits)).toBe(0.0);
      expect(Number(walletAfter.balanceCredits)).toBe(Number(walletBefore.balanceCredits));

      const reservation = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      expect(reservation.status).toBe('CANCELLED');
    });
  });

  describe('Workstream H: Event Ordering, Deduplication & Terminal State Safety', () => {
    it('safely deduplicates identical terminal webhook deliveries without double settlement', async () => {
      const carrierCallRef = `carr-dedup-${Date.now()}`;
      const eventId = `evt-dedup-${Date.now()}`;
      const call = await prisma.call.create({
        data: {
          organizationId: orgAId,
          agentId: agentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+15550100',
          destinationNumber: '+15550103',
          status: CallStatus.IN_PROGRESS,
          carrierCallId: carrierCallRef,
          durationSeconds: 30,
        },
      });

      const telephonyService = (app as any).telephonyService || activeTelephonyService;
      telephonyService.gateway.registerCallMapping(carrierCallRef, call.id);

      await telephonyService.walletService.createReservation({
        organizationId: orgAId,
        callId: call.id,
        amountCredits: 6.0,
      });

      const payload = {
        eventId,
        event: 'disconnected',
        carrierCallId: carrierCallRef,
        timestamp: Date.now(),
      };
      const raw = Buffer.from(JSON.stringify(payload));
      const nowSec = Math.floor(Date.now() / 1000);
      const sig1 = verifier.formatHeader(raw, nowSec);

      // Delivery 1
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: { 'content-type': 'application/json', 'x-auris-signature': sig1 },
        payload: raw,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().duplicate).toBe(false);

      const walletAfter1 = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgAId } });

      // Delivery 2 (Duplicate retry with fresh transport signature header)
      const sig2 = verifier.formatHeader(raw, nowSec + 1);
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: { 'content-type': 'application/json', 'x-auris-signature': sig2 },
        payload: raw,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().duplicate).toBe(true);

      const walletAfter2 = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgAId } });
      expect(Number(walletAfter2.balanceCredits)).toBe(Number(walletAfter1.balanceCredits)); // Exactly zero duplicate charges
    });

    it('returns HTTP 409 when same eventId is reused with conflicting payload hash', async () => {
      const eventId = `evt-conflict-${Date.now()}`;
      const carrierCallRef = `carr-conf-${Date.now()}`;

      const payloadA = {
        eventId,
        event: 'ringing',
        carrierCallId: carrierCallRef,
        timestamp: Date.now(),
        details: { sequence: 1 },
      };
      const rawA = Buffer.from(JSON.stringify(payloadA));

      const resA = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: { 'content-type': 'application/json', 'x-auris-signature': verifier.formatHeader(rawA) },
        payload: rawA,
      });
      expect(resA.statusCode).toBe(200);

      // Reused eventId with conflicting payload details
      const payloadB = {
        eventId,
        event: 'ringing',
        carrierCallId: carrierCallRef,
        timestamp: Date.now(),
        details: { sequence: 999, conflictingDetail: true },
      };
      const rawB = Buffer.from(JSON.stringify(payloadB));

      const resB = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: { 'content-type': 'application/json', 'x-auris-signature': verifier.formatHeader(rawB) },
        payload: rawB,
      });

      expect(resB.statusCode).toBe(409);
      expect(resB.json().error).toBe('WEBHOOK_PAYLOAD_CONFLICT');
    });

    it('prevents terminal call from being revived by late answer event', async () => {
      const carrierCallRef = `carr-terminal-${Date.now()}`;
      const call = await prisma.call.create({
        data: {
          organizationId: orgAId,
          agentId: agentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+15550100',
          destinationNumber: '+15550104',
          status: CallStatus.COMPLETED,
          carrierCallId: carrierCallRef,
          endedAt: new Date(),
        },
      });

      const telephonyService = (app as any).telephonyService || activeTelephonyService;
      telephonyService.gateway.registerCallMapping(carrierCallRef, call.id);

      // Send late answer event
      const lateAnswerPayload = {
        eventId: `late-ans-${Date.now()}`,
        event: 'answered',
        carrierCallId: carrierCallRef,
        timestamp: Date.now(),
      };
      const raw = Buffer.from(JSON.stringify(lateAnswerPayload));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: { 'content-type': 'application/json', 'x-auris-signature': verifier.formatHeader(raw) },
        payload: raw,
      });

      expect(res.statusCode).toBe(200);

      // Must remain COMPLETED, not revived to IN_PROGRESS
      const callAfter = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
      expect(callAfter.status).toBe(CallStatus.COMPLETED);
    });
  });

  describe('Workstream I: Security & Tenant Isolation', () => {
    it('strictly forbids User B from generating stream token for Org A call (404/403)', async () => {
      const callA = await prisma.call.create({
        data: {
          organizationId: orgAId,
          agentId: agentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+15550100',
          destinationNumber: '+15550105',
          status: CallStatus.RINGING,
          carrierCallId: `carr-sec-${Date.now()}`,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: {
          authorization: `Bearer ${userBToken}`,
        },
        payload: {
          callId: callA.id,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().message).toMatch(/not found or unauthorized/i);
    });

    it('rejects cross-tenant call reference mismatch with 400 CROSS_TENANT_CALL_MISMATCH', async () => {
      const carrierCallRef = `carr-trusted-${Date.now()}`;
      const telephonyService = (app as any).telephonyService || activeTelephonyService;
      telephonyService.gateway.registerCallMapping(carrierCallRef, 'call-trusted-org-a');

      // Attacker attempts to inject payload callId belonging to another tenant
      const maliciousPayload = {
        event: 'ringing',
        carrierCallId: carrierCallRef,
        callId: 'call-unauthorized-org-b',
        timestamp: Date.now(),
      };
      const raw = Buffer.from(JSON.stringify(maliciousPayload));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/telephony/webhook',
        headers: {
          'content-type': 'application/json',
          'x-auris-signature': verifier.formatHeader(raw),
        },
        payload: raw,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('CROSS_TENANT_CALL_MISMATCH');
    });

    it('rejects media WebSocket connection for terminal calls with code 1008', async () => {
      const call = await prisma.call.create({
        data: {
          organizationId: orgAId,
          agentId: agentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+15550100',
          destinationNumber: '+15550106',
          status: CallStatus.RINGING,
          carrierCallId: `carr-term-ws-${Date.now()}`,
        },
      });

      // Generate valid token while call is ringing
      const tokenRes = await app.inject({
        method: 'POST',
        url: '/v1/telephony/stream-token',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { callId: call.id },
      });
      expect(tokenRes.statusCode).toBe(200);
      const { token } = tokenRes.json();

      // Transition call to COMPLETED in DB prior to socket attachment
      await prisma.call.update({
        where: { id: call.id },
        data: { status: CallStatus.COMPLETED, endedAt: new Date() },
      });

      const ws = new WebSocket(`${wsServerUrl}/v1/telephony/stream?callId=${call.id}&token=${token}`);
      const closeEvent = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      expect(closeEvent.code).toBe(1008);
      expect(closeEvent.reason).toMatch(/terminal state/i);
    });
  });

  describe('Workstream E & F: G.711 μ-Law Codec & Frame Transport Integration', () => {
    it('encodes and decodes 20ms frames seamlessly via G711MuLawCodec', () => {
      const codec = new G711MuLawCodec();
      const pcm16k = Buffer.alloc(640);
      for (let i = 0; i < 320; i++) {
        pcm16k.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
      }

      const mulaw = codec.encode(pcm16k);
      expect(mulaw.length).toBe(160);

      const decoded = codec.decode(mulaw);
      expect(decoded.length).toBe(640);
    });
  });
});
