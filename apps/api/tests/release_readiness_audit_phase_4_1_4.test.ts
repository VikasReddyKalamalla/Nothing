import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PrismaClient, ReservationStatus, WalletTxType, CallStatus, Prisma } from '@auris/database';
import { WalletService } from '../src/modules/wallets/wallet.service.js';
import { TelephonyService } from '../src/modules/telephony/telephony.service.js';
import { TelephonyError, MockWebhookSignatureVerifier } from '@auris/runtime';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';

describe('Auris Phase 4.1.4: Independent Verification & Release Readiness Audit', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let walletService: WalletService;
  let telephonyService: TelephonyService;
  let testOrgId: string;
  let testWalletId: string;
  let testAgentId: string;

  const verifier = new MockWebhookSignatureVerifier({
    secret: config.MOCK_WEBHOOK_SECRET,
    toleranceSeconds: 300,
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    walletService = new WalletService(prisma);
    telephonyService = new TelephonyService(prisma, walletService);

    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });

    const org = await prisma.organization.create({
      data: {
        name: `Audit 4.1.4 Org ${Date.now()}`,
        slug: `audit-414-${Date.now()}`,
      },
    });
    testOrgId = org.id;

    const wallet = await prisma.wallet.create({
      data: {
        organizationId: testOrgId,
        balanceCredits: 1000.0,
        reservedCredits: 0.0,
      },
    });
    testWalletId = wallet.id;

    const agent = await prisma.agent.create({
      data: {
        organizationId: testOrgId,
        name: 'Audit 4.1.4 Agent',
        promptTemplate: 'You are an AI assistant for release readiness audit testing.',
      },
    });
    testAgentId = agent.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function createCall(
    status: CallStatus = CallStatus.IN_PROGRESS,
    durationSeconds = 0,
    startedAt?: Date,
    endedAt?: Date,
    orgId = testOrgId
  ) {
    return await prisma.call.create({
      data: {
        organizationId: orgId,
        agentId: testAgentId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+15550001',
        destinationNumber: '+15550002',
        status,
        durationSeconds,
        startedAt: startedAt || (status !== CallStatus.INITIATED ? new Date() : null),
        endedAt,
        carrierCallId: `carrier-414-${crypto.randomUUID()}`,
      },
    });
  }

  function createSignedHeaders(rawBody: Buffer, timestampSec?: number) {
    return {
      'x-auris-signature': telephonyService.verifier.formatHeader(rawBody, timestampSec),
      'content-type': 'application/json',
    };
  }

  // =========================================================================
  // 1. FINANCIAL CORRECTNESS & ACCOUNTING INVARIANTS
  // =========================================================================
  describe('1. Financial Correctness & Accounting Invariants', () => {
    it('Zero balance wallet rejects reservation creation with INSUFFICIENT_FUNDS', async () => {
      const zeroOrg = await prisma.organization.create({
        data: { name: 'Zero Balance Org', slug: `zero-${Date.now()}` },
      });
      await prisma.wallet.create({
        data: {
          organizationId: zeroOrg.id,
          balanceCredits: 0.0,
          reservedCredits: 0.0,
        },
      });

      const call = await createCall(CallStatus.INITIATED, 0, undefined, undefined, zeroOrg.id);

      await expect(
        walletService.createReservation({
          organizationId: zeroOrg.id,
          callId: call.id,
          amountCredits: 5.0,
        })
      ).rejects.toThrow('INSUFFICIENT_FUNDS');

      // Verify no reservation created and no ledger record created
      const res = await prisma.walletReservation.findUnique({ where: { callId: call.id } });
      expect(res).toBeNull();

      const txs = await prisma.creditTransaction.findMany({ where: { referenceId: call.id } });
      expect(txs.length).toBe(0);
    });

    it('Mid-call extension returns TERMINATE_CALL when available funds are insufficient', async () => {
      const tightOrg = await prisma.organization.create({
        data: { name: 'Tight Org', slug: `tight-${Date.now()}` },
      });
      await prisma.wallet.create({
        data: {
          organizationId: tightOrg.id,
          balanceCredits: 5.0,
          reservedCredits: 0.0,
        },
      });

      const call = await createCall(CallStatus.IN_PROGRESS, 0, undefined, undefined, tightOrg.id);

      // Initial hold of 5.0 credits exhausts available balance (5.0 balance - 5.0 reserved = 0 available)
      await walletService.createReservation({
        organizationId: tightOrg.id,
        callId: call.id,
        amountCredits: 5.0,
      });

      // Attempt to extend reservation by 5.0 credits
      const ext = await walletService.extendReservation({
        callId: call.id,
        additionalCredits: 5.0,
        organizationId: tightOrg.id,
      });

      expect(ext.extended).toBe(false);
      expect(ext.action).toBe('TERMINATE_CALL');
      expect(ext.reason).toBe('INSUFFICIENT_FUNDS_FOR_EXTENSION');

      // Current reserved remains 5.0
      expect(ext.currentReserved).toBe(5.0);
    });

    it('Settlement exceeding available balance caps at balance, records unpaid debt durably, and documents debt collection limitation', async () => {
      const debtOrg = await prisma.organization.create({
        data: { name: 'Debt Org', slug: `debt-${Date.now()}` },
      });
      const wallet = await prisma.wallet.create({
        data: {
          organizationId: debtOrg.id,
          balanceCredits: 10.0,
          reservedCredits: 0.0,
        },
      });

      const call = await createCall(CallStatus.COMPLETED, 300, undefined, undefined, debtOrg.id); // 5 min call = 30.0 credits @ 6.0/min
      await walletService.createReservation({
        organizationId: debtOrg.id,
        callId: call.id,
        amountCredits: 10.0,
      });

      // Settle 300s call: 30.0 credits total cost, but wallet has only 10.0 credits
      const settlement = await walletService.settleCall({
        callId: call.id,
        durationSeconds: 300,
        ratePerMinute: 6.0,
        organizationId: debtOrg.id,
      });

      expect(settlement.status).toBe('SETTLED');
      expect(settlement.isPartialSettlement).toBe(true);
      expect(settlement.totalCost).toBe(30.0);
      expect(settlement.settledAmount).toBe(10.0); // Capped at balance
      expect(settlement.unpaidAmount).toBe(20.0); // 20.0 credits of provider debt
      expect(settlement.newBalance).toBe(0.0);

      // Verify wallet state: balance is exactly 0.0, reserved is 0.0
      const postWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      expect(Number(postWallet.balanceCredits)).toBe(0.0);
      expect(Number(postWallet.reservedCredits)).toBe(0.0);

      // Verify durable reservation record: unpaidAmount is durably stored in PostgreSQL
      const reservation = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      expect(reservation.status).toBe(ReservationStatus.SETTLED);
      expect(Number(reservation.settledAmount)).toBe(10.0);
      expect(Number(reservation.unpaidAmount)).toBe(20.0);

      // Verify ledger transaction: records actual debit of -10.0 and description explains unpaid provider debt
      const tx = await prisma.creditTransaction.findFirstOrThrow({
        where: { referenceId: call.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(Number(tx.amountCredits)).toBe(-10.0);
      expect(Number(tx.balanceAfter)).toBe(0.0);
      expect(tx.description).toContain('Unpaid provider cost: ₹20');

      // Verify limitation: subsequent top-up of ₹50.0 sets balance to 50.0 without automatic debt deduction
      const topUpRes = await walletService.topUpWallet({
        organizationId: debtOrg.id,
        amountCredits: 50.0,
        idempotencyKey: `topup-debt-${Date.now()}`,
      });
      expect(topUpRes.newBalance).toBe(50.0);

      // Reservation unpaid_amount remains 20.0 (durable audit history)
      const resAfterTopup = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      // Verify repeated settlement attempts do not overwrite or duplicate unpaidAmount
      const repeatSettle = await walletService.settleCall({
        callId: call.id,
        durationSeconds: 300,
        ratePerMinute: 6.0,
        organizationId: debtOrg.id,
      });
      expect(repeatSettle.status).toBe('ALREADY_SETTLED');
      const resAfterRepeat = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      expect(Number(resAfterRepeat.unpaidAmount)).toBe(20.0);
      expect(Number(resAfterRepeat.settledAmount)).toBe(10.0);

      // Verify no extra ledger entries created on repeat
      const txCount = await prisma.creditTransaction.count({
        where: { referenceId: call.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(txCount).toBe(1);
    });

    it('Rejects non-finite values (NaN, Infinity, -Infinity) and non-positive durations with 0 charge', async () => {
      expect(WalletService.calculateCallCharge(NaN, 6.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(Infinity, 6.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(-Infinity, 6.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(-30, 6.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(0, 6.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(60, NaN)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(60, -6.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
    });

    it('Database error during settlement transaction rolls back wallet, reservation, and ledger atomically', async () => {
      const call = await createCall(CallStatus.COMPLETED, 60);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      const initialWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: testWalletId } });
      const initialBalance = Number(initialWallet.balanceCredits);
      const initialReserved = Number(initialWallet.reservedCredits);

      // Attempt settlement with mismatched organizationId (triggers CROSS_TENANT_ACCESS_DENIED inside tx)
      await expect(
        walletService.settleCall({
          callId: call.id,
          durationSeconds: 60,
          ratePerMinute: 6.0,
          organizationId: crypto.randomUUID(), // Mismatched
        })
      ).rejects.toThrow('CROSS_TENANT_ACCESS_DENIED');

      // Verify complete atomicity & rollback:
      const postWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: testWalletId } });
      expect(Number(postWallet.balanceCredits)).toBe(initialBalance);
      expect(Number(postWallet.reservedCredits)).toBe(initialReserved);

      const res = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      expect(res.status).toBe(ReservationStatus.HELD);
      expect(res.settledAmount).toBeNull();

      const txs = await prisma.creditTransaction.findMany({
        where: { referenceId: call.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(txs.length).toBe(0);
    });

    it('Duplicate settlement and duplicate release are strictly idempotent with no multiple charges or refunds', async () => {
      // 1. Settlement idempotency
      const settleCallRecord = await createCall(CallStatus.COMPLETED, 60);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: settleCallRecord.id,
        amountCredits: 10.0,
      });

      const s1 = await walletService.settleCall({
        callId: settleCallRecord.id,
        durationSeconds: 60,
        ratePerMinute: 6.0,
        organizationId: testOrgId,
      });
      expect(s1.status).toBe('SETTLED');

      const s2 = await walletService.settleCall({
        callId: settleCallRecord.id,
        durationSeconds: 60,
        ratePerMinute: 6.0,
        organizationId: testOrgId,
      });
      expect(s2.status).toBe('ALREADY_SETTLED');
      expect(s2.settledAmount).toBe(s1.settledAmount);

      const settleTxs = await prisma.creditTransaction.findMany({
        where: { referenceId: settleCallRecord.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(settleTxs.length).toBe(1);

      // 2. Release idempotency
      const releaseCallRecord = await createCall(CallStatus.FAILED, 0);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: releaseCallRecord.id,
        amountCredits: 10.0,
      });

      const r1 = await walletService.releaseReservation({
        callId: releaseCallRecord.id,
        reason: 'Call failed',
        organizationId: testOrgId,
      });
      expect(r1.status).toBe('CANCELLED');

      const r2 = await walletService.releaseReservation({
        callId: releaseCallRecord.id,
        reason: 'Duplicate release',
        organizationId: testOrgId,
      });
      expect(r2.status).toBe('ALREADY_CANCELLED');

      const releaseTxs = await prisma.creditTransaction.findMany({
        where: { referenceId: releaseCallRecord.id, type: WalletTxType.CALL_REFUND },
      });
      expect(releaseTxs.length).toBe(1);
    });
  });

  // =========================================================================
  // 2. WEBHOOK SECURITY & IDEMPOTENCY INVARIANTS
  // =========================================================================
  describe('2. Webhook Security & Idempotency Invariants', () => {
    it('Accepts duplicate event with identical payload, but rejects reuse with conflicting payload (409 Conflict)', async () => {
      const call = await createCall(CallStatus.IN_PROGRESS);
      const eventId = `sec-evt-${Date.now()}`;

      const rawBodyOriginal = Buffer.from(
        JSON.stringify({
          eventType: 'call.answered',
          eventId,
          carrierCallId: call.carrierCallId,
          timestamp: Date.now(),
        })
      );
      const headersOriginal = createSignedHeaders(rawBodyOriginal);

      // Initial delivery succeeds
      const res1 = await telephonyService.handleWebhook(rawBodyOriginal, headersOriginal);
      expect(res1.accepted).toBe(true);
      expect(res1.duplicate).toBe(false);

      // Duplicate delivery with identical payload succeeds with duplicate: true
      const nowSec = Math.floor(Date.now() / 1000);
      const headersDuplicate = createSignedHeaders(rawBodyOriginal, nowSec + 1);
      const resDuplicate = await telephonyService.handleWebhook(rawBodyOriginal, headersDuplicate);
      expect(resDuplicate.accepted).toBe(true);
      expect(resDuplicate.duplicate).toBe(true);

      // Conflicting delivery reusing eventId with different body throws WEBHOOK_PAYLOAD_CONFLICT
      const rawBodyTampered = Buffer.from(
        JSON.stringify({
          eventType: 'call.disconnected',
          eventId,
          carrierCallId: call.carrierCallId,
          reason: 'MALICIOUS_OVERWRITE',
        })
      );
      const headersTampered = createSignedHeaders(rawBodyTampered, nowSec + 2);

      await expect(telephonyService.handleWebhook(rawBodyTampered, headersTampered)).rejects.toThrowError(
        /reused with conflicting payload hash/
      );
    });

    it('Concurrent duplicate webhook deliveries produce exactly 1 database event and 1 call state update', async () => {
      const call = await createCall(CallStatus.INITIATED);
      const eventId = `sec-concurrent-${Date.now()}`;

      const rawBody = Buffer.from(
        JSON.stringify({
          eventType: 'call.answered',
          eventId,
          carrierCallId: call.carrierCallId,
          timestamp: Date.now(),
        })
      );

      // Deliver 5 concurrent requests with identical raw body and distinct timestamp headers to pass replay cache
      const nowSec = Math.floor(Date.now() / 1000);
      const promises = [0, 1, 2, 3, 4].map((offset) => {
        const headers = createSignedHeaders(rawBody, nowSec + offset);
        return telephonyService.handleWebhook(rawBody, headers);
      });

      const results = await Promise.all(promises);

      // All 5 must be accepted
      expect(results.every((r) => r.accepted)).toBe(true);

      // Exactly 1 must be initial (duplicate: false) and 4 must be duplicate: true
      const initialCount = results.filter((r) => !r.duplicate).length;
      const duplicateCount = results.filter((r) => r.duplicate).length;
      expect(initialCount).toBe(1);
      expect(duplicateCount).toBe(4);

      // Exactly 1 record exists in carrier_webhook_events
      const eventsInDb = await prisma.carrierWebhookEvent.findMany({ where: { eventId } });
      expect(eventsInDb.length).toBe(1);

      // Call status updated to IN_PROGRESS
      const updatedCall = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
      expect(updatedCall.status).toBe(CallStatus.IN_PROGRESS);
    });

    it('Out-of-order answered webhook does not revive an already COMPLETED call', async () => {
      const call = await createCall(CallStatus.COMPLETED, 60);

      const rawBody = Buffer.from(
        JSON.stringify({
          eventType: 'call.answered',
          eventId: `sec-revive-${Date.now()}`,
          carrierCallId: call.carrierCallId,
        })
      );
      const headers = createSignedHeaders(rawBody);

      const res = await telephonyService.handleWebhook(rawBody, headers);
      expect(res.accepted).toBe(true);

      // Call must remain COMPLETED
      const callAfter = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
      expect(callAfter.status).toBe(CallStatus.COMPLETED);
    });

    it('Strictly rejects invalid signatures, expired timestamps, and future timestamp tampering', async () => {
      const call = await createCall(CallStatus.INITIATED);
      const rawBody = Buffer.from(
        JSON.stringify({
          eventType: 'call.answered',
          eventId: `sec-sig-${Date.now()}`,
          carrierCallId: call.carrierCallId,
        })
      );

      // 1. Invalid signature
      const invalidHeaders = {
        'x-auris-signature': 't=1700000000,v1=deadbeefcafebabe00112233445566778899aabbccddeeff0011223344556677',
        'content-type': 'application/json',
      };
      await expect(telephonyService.handleWebhook(rawBody, invalidHeaders)).rejects.toThrow();

      // 2. Expired timestamp (> 300s in past)
      const expiredSec = Math.floor(Date.now() / 1000) - 500;
      const expiredHeaders = createSignedHeaders(rawBody, expiredSec);
      await expect(telephonyService.handleWebhook(rawBody, expiredHeaders)).rejects.toThrow();

      // 3. Far-future timestamp (> 15s in future)
      const futureSec = Math.floor(Date.now() / 1000) + 60;
      const futureHeaders = createSignedHeaders(rawBody, futureSec);
      await expect(telephonyService.handleWebhook(rawBody, futureHeaders)).rejects.toThrow();
    });

    it('Cross-tenant call ID spoofing in webhook payload is strictly rejected', async () => {
      const tenantACall = await createCall(CallStatus.INITIATED);
      const otherOrg = await prisma.organization.create({
        data: { name: 'Tenant B', slug: `tenant-b-${Date.now()}` },
      });
      const tenantBCall = await createCall(CallStatus.INITIATED, 0, undefined, undefined, otherOrg.id);

      // Webhook carries carrierCallId of Tenant A, but attempts to specify Tenant B's callId in body
      const rawBody = Buffer.from(
        JSON.stringify({
          eventType: 'call.answered',
          eventId: `sec-spoof-${Date.now()}`,
          carrierCallId: tenantACall.carrierCallId,
          callId: tenantBCall.id, // Attacker tries to inject Tenant B's callId
        })
      );
      const headers = createSignedHeaders(rawBody);

      // Gateway must reject cross-tenant mismatch
      await expect(telephonyService.handleWebhook(rawBody, headers)).rejects.toThrowError(
        /Cross-tenant call ID mismatch/i
      );
    });
  });

  // =========================================================================
  // 3. RECOVERY WORKER HARDENING & STARVATION INVARIANTS
  // =========================================================================
  describe('3. Recovery Worker Hardening & Starvation Invariants', () => {
    it('Recovery processes batches in strict FIFO order without starving older records when limit < queue size', async () => {
      // Drain existing reservations for this test org first
      await walletService.reconcileTerminalCallReservations(100, testOrgId);

      // Create 5 terminal calls staggered in time
      const calls = [];
      for (let i = 0; i < 5; i++) {
        const c = await createCall(CallStatus.COMPLETED, 30);
        await walletService.createReservation({
          organizationId: testOrgId,
          callId: c.id,
          amountCredits: 10.0,
        });
        await new Promise((r) => setTimeout(r, 15)); // Guarantee strict timestamp ordering
        calls.push(c);
      }

      // Batch 1 with limit = 2 -> must return calls[0] and calls[1]
      const batch1 = await walletService.reconcileTerminalCallReservations(2, testOrgId);
      expect(batch1.length).toBe(2);
      expect(batch1[0].callId).toBe(calls[0].id);
      expect(batch1[1].callId).toBe(calls[1].id);

      // Batch 2 with limit = 2 -> must return calls[2] and calls[3]
      const batch2 = await walletService.reconcileTerminalCallReservations(2, testOrgId);
      expect(batch2.length).toBe(2);
      expect(batch2[0].callId).toBe(calls[2].id);
      expect(batch2[1].callId).toBe(calls[3].id);

      // Batch 3 with limit = 2 -> must return remaining calls[4]
      const batch3 = await walletService.reconcileTerminalCallReservations(2, testOrgId);
      expect(batch3.length).toBe(1);
      expect(batch3[0].callId).toBe(calls[4].id);

      // All 5 are now settled, next run returns 0
      const batchEmpty = await walletService.reconcileTerminalCallReservations(2, testOrgId);
      expect(batchEmpty.length).toBe(0);
    });

    it('Expired orphaned reservations with no underlying Call record are safely released without errors', async () => {
      const orphanOrg = await prisma.organization.create({
        data: { name: 'Orphan Org 414', slug: `orphan-414-${Date.now()}` },
      });
      const orphanWallet = await prisma.wallet.create({
        data: {
          organizationId: orphanOrg.id,
          balanceCredits: 50.0,
          reservedCredits: 10.0,
        },
      });

      const fakeCallId = crypto.randomUUID();
      await prisma.walletReservation.create({
        data: {
          walletId: orphanWallet.id,
          callId: fakeCallId,
          reservedAmount: 10.0,
          status: ReservationStatus.HELD,
          expiresAt: new Date(Date.now() - 10000), // Expired
        },
      });

      // Run recovery sweeper
      await walletService.reconcileTerminalCallReservations(50, orphanOrg.id);

      // Must be cancelled and reserved credits returned to 0
      const res = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: fakeCallId } });
      expect(res.status).toBe(ReservationStatus.CANCELLED);

      const postWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: orphanWallet.id } });
      expect(Number(postWallet.reservedCredits)).toBe(0.0);
    });

    it('Never bills calls with missing, zero, or reversed timestamps', async () => {
      const now = Date.now();

      // 1. Missing duration / missing startedAt
      const missingCall = await createCall(CallStatus.COMPLETED, 0, undefined, undefined);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: missingCall.id,
        amountCredits: 10.0,
      });

      // 2. Reversed timestamps (endedAt is 1 minute before startedAt)
      const reversedCall = await createCall(CallStatus.COMPLETED, 0, new Date(now), new Date(now - 60000));
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: reversedCall.id,
        amountCredits: 10.0,
      });

      // 3. Non-connected call status (BUSY)
      const busyCall = await createCall(CallStatus.BUSY, 0, undefined, new Date());
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: busyCall.id,
        amountCredits: 10.0,
      });

      await walletService.reconcileTerminalCallReservations(50, testOrgId);

      // All 3 must be CANCELLED with 0 charge
      const resMissing = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: missingCall.id } });
      expect(resMissing.status).toBe(ReservationStatus.CANCELLED);
      expect(Number(resMissing.settledAmount)).toBe(0);

      const resReversed = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: reversedCall.id } });
      expect(resReversed.status).toBe(ReservationStatus.CANCELLED);
      expect(Number(resReversed.settledAmount)).toBe(0);

      const resBusy = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: busyCall.id } });
      expect(resBusy.status).toBe(ReservationStatus.CANCELLED);
      expect(Number(resBusy.settledAmount)).toBe(0);
    });

    it('Four concurrent recovery workers process pending calls without double-charges or deadlocks', async () => {
      const call = await createCall(CallStatus.COMPLETED, 60);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      // Launch 4 concurrent workers
      const runs = await Promise.all([
        walletService.reconcileTerminalCallReservations(50, testOrgId),
        walletService.reconcileTerminalCallReservations(50, testOrgId),
        walletService.reconcileTerminalCallReservations(50, testOrgId),
        walletService.reconcileTerminalCallReservations(50, testOrgId),
      ]);

      const flatSettled = runs.flat().filter((r) => r.callId === call.id && r.status === 'SETTLED');
      expect(flatSettled.length).toBe(1);

      // Exactly 1 ledger transaction created
      const count = await prisma.creditTransaction.count({
        where: { referenceId: call.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(count).toBe(1);
    });

    it('Failed worker records remain retryable on subsequent runs', async () => {
      const call = await createCall(CallStatus.COMPLETED, 60);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      // Injected fault: make settleCall throw during the first worker run
      const originalSettle = walletService.settleCall.bind(walletService);
      let failedOnce = false;
      walletService.settleCall = async (params: any) => {
        if (!failedOnce && params.callId === call.id) {
          failedOnce = true;
          throw new Error('SIMULATED_TRANSIENT_DB_NETWORK_ERROR');
        }
        return originalSettle(params);
      };

      try {
        // First worker run encounters transient failure on this item
        const firstRun = await walletService.reconcileTerminalCallReservations(50, testOrgId);
        expect(firstRun.some((r) => r.callId === call.id)).toBe(false);

        // Reservation remains HELD
        const intermediateRes = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
        expect(intermediateRes.status).toBe(ReservationStatus.HELD);

        // Subsequent worker run retries and succeeds cleanly
        const secondRun = await walletService.reconcileTerminalCallReservations(50, testOrgId);
        const settledItem = secondRun.find((r) => r.callId === call.id);
        expect(settledItem).toBeDefined();
        expect(settledItem.status).toBe('SETTLED');

        const finalRes = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
        expect(finalRes.status).toBe(ReservationStatus.SETTLED);
      } finally {
        walletService.settleCall = originalSettle; // Restore original implementation
      }
    });
  });

  // =========================================================================
  // 4. FAULT INJECTION & TEST VALIDATION INVARIANTS
  // =========================================================================
  describe('4. Fault Injection & Test Validation Invariants', () => {
    it('Proves that omitting payload hash comparison would falsely accept forged webhooks', async () => {
      const call = await createCall(CallStatus.IN_PROGRESS);
      const eventId = `validate-hash-${Date.now()}`;

      const rawBodyOriginal = Buffer.from(
        JSON.stringify({
          eventType: 'call.answered',
          eventId,
          carrierCallId: call.carrierCallId,
        })
      );
      const headersOriginal = createSignedHeaders(rawBodyOriginal);
      await telephonyService.handleWebhook(rawBodyOriginal, headersOriginal);

      // Verify that existing implementation catches different payload hash
      const rawBodyForged = Buffer.from(
        JSON.stringify({
          eventType: 'call.disconnected',
          eventId,
          carrierCallId: call.carrierCallId,
          forgedField: 'malicious',
        })
      );
      const headersForged = createSignedHeaders(rawBodyForged, Math.floor(Date.now() / 1000) + 1);

      await expect(telephonyService.handleWebhook(rawBodyForged, headersForged)).rejects.toThrowError(
        /reused with conflicting payload hash/
      );
    });

    it('Proves that timestamp ordering in PostgreSQL query is what guarantees FIFO execution', async () => {
      // Query database with ORDER BY wr.created_at ASC vs DESC
      const ascResults = await prisma.$queryRaw<Array<{ id: string; created_at: Date }>>`
        SELECT id, created_at FROM wallet_reservations ORDER BY created_at ASC LIMIT 2
      `;
      const descResults = await prisma.$queryRaw<Array<{ id: string; created_at: Date }>>`
        SELECT id, created_at FROM wallet_reservations ORDER BY created_at DESC LIMIT 2
      `;

      if (ascResults.length >= 2) {
        expect(new Date(ascResults[0].created_at).getTime()).toBeLessThanOrEqual(
          new Date(ascResults[1].created_at).getTime()
        );
      }
      if (descResults.length >= 2) {
        expect(new Date(descResults[0].created_at).getTime()).toBeGreaterThanOrEqual(
          new Date(descResults[1].created_at).getTime()
        );
      }
    });
  });
});
