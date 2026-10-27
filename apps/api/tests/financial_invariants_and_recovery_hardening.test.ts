import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient, ReservationStatus, WalletTxType } from '@auris/database';
import { WalletService } from '../src/modules/wallets/wallet.service.js';
import { TelephonyService } from '../src/modules/telephony/telephony.service.js';
import { TelephonyError } from '@auris/runtime';

describe('Phase 4.1.3: Financial Invariants & Recovery Worker Hardening Audit', () => {
  let prisma: PrismaClient;
  let walletService: WalletService;
  let telephonyService: TelephonyService;
  let testOrgId: string;
  let testWalletId: string;
  let testAgentId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    walletService = new WalletService(prisma);
    telephonyService = new TelephonyService(prisma, walletService);

    const org = await prisma.organization.create({
      data: {
        name: `Audit 4.1.3 Org ${Date.now()}`,
        slug: `audit-413-${Date.now()}`,
      },
    });
    testOrgId = org.id;

    const wallet = await prisma.wallet.create({
      data: {
        organizationId: testOrgId,
        balanceCredits: 500.0,
        reservedCredits: 0.0,
      },
    });
    testWalletId = wallet.id;

    const agent = await prisma.agent.create({
      data: {
        organizationId: testOrgId,
        name: 'Audit 4.1.3 Agent',
        promptTemplate: 'You are an AI assistant for financial audit testing.',
      },
    });
    testAgentId = agent.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Helper to create Call record
  async function createCall(status: any = 'IN_PROGRESS', durationSeconds = 0, startedAt?: Date, endedAt?: Date) {
    return await prisma.call.create({
      data: {
        organizationId: testOrgId,
        agentId: testAgentId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+15550001',
        destinationNumber: '+15550002',
        status,
        durationSeconds,
        startedAt: startedAt || (status !== 'INITIATED' ? new Date() : null),
        endedAt,
        carrierCallId: `carrier-${crypto.randomUUID()}`,
      },
    });
  }

  // Helper to create HMAC webhook signature
  function createSignedHeaders(rawBody: Buffer) {
    return {
      'x-auris-signature': telephonyService.verifier.formatHeader(rawBody),
      'content-type': 'application/json',
    };
  }

  describe('Stage 2 — Financial Invariants (Invariants 1 to 12)', () => {
    it('Invariant 1 & 4: A reservation produces at most one successful settlement; repeated attempts do not double deduct', async () => {
      const call = await createCall('COMPLETED', 60);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      const initialWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: testWalletId } });
      const initialBalance = Number(initialWallet.balanceCredits);

      // First settlement (60s @ 6.0/min = 6.0 credits)
      const res1 = await walletService.settleCall({
        callId: call.id,
        durationSeconds: 60,
        ratePerMinute: 6.0,
        organizationId: testOrgId,
        idempotencyKey: `settle:inv1:${call.id}`,
      });
      expect(res1.status).toBe('SETTLED');
      expect(res1.settledAmount).toBe(6.0);

      // Second settlement attempt with same or different parameters
      const res2 = await walletService.settleCall({
        callId: call.id,
        durationSeconds: 60,
        ratePerMinute: 6.0,
        organizationId: testOrgId,
        idempotencyKey: `settle:inv1:${call.id}`,
      });
      expect(res2.status).toBe('ALREADY_SETTLED');
      expect(res2.settledAmount).toBe(6.0);

      const postWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: testWalletId } });
      expect(Number(postWallet.balanceCredits)).toBe(initialBalance - 6.0);

      // Exactly 1 settlement transaction in ledger
      const txs = await prisma.creditTransaction.findMany({
        where: { referenceId: call.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(txs.length).toBe(1);
      expect(Number(txs[0].amountCredits)).toBe(-6.0);
    });

    it('Invariant 2 & 5: A reservation cannot be both settled and released; repeated releases do not double refund', async () => {
      const call = await createCall('FAILED', 0);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      const initialWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: testWalletId } });
      const initialReserved = Number(initialWallet.reservedCredits);

      // First release
      const rel1 = await walletService.releaseReservation({
        callId: call.id,
        reason: 'Call failed before connection',
        organizationId: testOrgId,
      });
      expect(rel1.status).toBe('CANCELLED');

      // Second release
      const rel2 = await walletService.releaseReservation({
        callId: call.id,
        reason: 'Duplicate release attempt',
        organizationId: testOrgId,
      });
      expect(rel2.status).toBe('ALREADY_CANCELLED');

      const midWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: testWalletId } });
      expect(Number(midWallet.reservedCredits)).toBe(initialReserved - 10.0);

      // Attempting to settle a cancelled reservation must be rejected
      await expect(
        walletService.settleCall({
          callId: call.id,
          durationSeconds: 60,
          ratePerMinute: 6.0,
          organizationId: testOrgId,
        })
      ).rejects.toThrow('RESERVATION_ALREADY_CANCELLED');

      // Attempting to cancel a settled reservation must also be rejected
      const settledCall = await createCall('COMPLETED', 30);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: settledCall.id,
        amountCredits: 5.0,
      });
      await walletService.settleCall({
        callId: settledCall.id,
        durationSeconds: 30,
        ratePerMinute: 6.0,
        organizationId: testOrgId,
      });

      await expect(
        walletService.releaseReservation({
          callId: settledCall.id,
          reason: 'Attempt cancel after settlement',
          organizationId: testOrgId,
        })
      ).rejects.toThrow('CANNOT_CANCEL_SETTLED_RESERVATION');
    });

    it('Invariant 3 & 7: Failed settlement cannot be reported as successful; every debit has durable ledger record', async () => {
      const call = await createCall('COMPLETED', 45);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      // Inject failure by querying with a non-existent wallet / wrong organization
      await expect(
        walletService.settleCall({
          callId: call.id,
          durationSeconds: 45,
          ratePerMinute: 6.0,
          organizationId: crypto.randomUUID(), // Cross-tenant / wrong org
        })
      ).rejects.toThrow('CROSS_TENANT_ACCESS_DENIED');

      // Verify no debit occurred and reservation remains HELD
      const res = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      expect(res.status).toBe(ReservationStatus.HELD);
      expect(res.settledAmount).toBeNull();

      // No CALL_SETTLEMENT ledger record was created
      const txCount = await prisma.creditTransaction.count({
        where: { referenceId: call.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(txCount).toBe(0);

      // Now execute valid settlement: must succeed and produce durable ledger record
      const validSettle = await walletService.settleCall({
        callId: call.id,
        durationSeconds: 45,
        ratePerMinute: 6.0,
        organizationId: testOrgId,
      });
      expect(validSettle.status).toBe('SETTLED');

      const ledgerRecord = await prisma.creditTransaction.findFirst({
        where: { referenceId: call.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(ledgerRecord).not.toBeNull();
      expect(Number(ledgerRecord!.amountCredits)).toBe(-validSettle.settledAmount);
    });

    it('Invariant 6: Concurrent settlement and release cannot both apply conflicting financial effects', async () => {
      const call = await createCall('COMPLETED', 60);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      // Fire settle and release concurrently
      const [settleRes, releaseRes] = await Promise.allSettled([
        walletService.settleCall({
          callId: call.id,
          durationSeconds: 60,
          ratePerMinute: 6.0,
          organizationId: testOrgId,
        }),
        walletService.releaseReservation({
          callId: call.id,
          reason: 'Race test release',
          organizationId: testOrgId,
        }),
      ]);

      const reservation = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });

      // Exactly one status can be active
      expect([ReservationStatus.SETTLED, ReservationStatus.CANCELLED]).toContain(reservation.status);

      if (reservation.status === ReservationStatus.SETTLED) {
        expect(settleRes.status).toBe('fulfilled');
        expect(releaseRes.status).toBe('rejected'); // CANNOT_CANCEL_SETTLED_RESERVATION
      } else {
        expect(releaseRes.status).toBe('fulfilled');
        expect(settleRes.status).toBe('rejected'); // RESERVATION_ALREADY_CANCELLED
      }
    });

    it('Invariant 8: Balance, reservation status, and ledger remain consistent under overdraft capping', async () => {
      // Create a temporary wallet with small balance (2.0 credits)
      const poorOrg = await prisma.organization.create({
        data: { name: 'Poor Org', slug: `poor-${Date.now()}` },
      });
      await prisma.wallet.create({
        data: {
          organizationId: poorOrg.id,
          balanceCredits: 2.0,
          reservedCredits: 0.0,
        },
      });

      const poorCall = await prisma.call.create({
        data: {
          organizationId: poorOrg.id,
          agentId: testAgentId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+15551111',
          destinationNumber: '+15552222',
          status: 'COMPLETED',
          durationSeconds: 120, // 2 minutes @ 6.0 = 12.0 credits, exceeds 2.0 balance
          carrierCallId: `poor-${crypto.randomUUID()}`,
        },
      });

      await walletService.createReservation({
        organizationId: poorOrg.id,
        callId: poorCall.id,
        amountCredits: 2.0,
      });

      // Settle 120s call: charge is 12.0 credits, but balance is only 2.0 credits
      const settleResult = await walletService.settleCall({
        callId: poorCall.id,
        durationSeconds: 120,
        ratePerMinute: 6.0,
        organizationId: poorOrg.id,
      });

      expect(settleResult.status).toBe('SETTLED');
      expect(settleResult.isPartialSettlement).toBe(true);
      expect(settleResult.settledAmount).toBe(2.0); // Capped at balance
      expect(settleResult.unpaidAmount).toBe(10.0);
      expect(settleResult.newBalance).toBe(0.0);

      // Verify wallet invariant: balance never negative
      const poorWallet = await prisma.wallet.findUniqueOrThrow({
        where: { organizationId: poorOrg.id },
      });
      expect(Number(poorWallet.balanceCredits)).toBe(0.0);
      expect(Number(poorWallet.reservedCredits)).toBe(0.0);

      const reservation = await prisma.walletReservation.findUniqueOrThrow({
        where: { callId: poorCall.id },
      });
      expect(reservation.status).toBe(ReservationStatus.SETTLED);
      expect(Number(reservation.settledAmount)).toBe(2.0);
      expect(Number(reservation.unpaidAmount)).toBe(10.0);
    });

    it('Invariant 10, 11 & 12: Recovery never bills non-billable calls, uses 30s block rounding, and handles reversed timestamps cleanly', async () => {
      // 1. Unanswered call (0 duration, no startedAt)
      const unansweredCall = await createCall('NO_ANSWER', 0, undefined, new Date());
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: unansweredCall.id,
        amountCredits: 10.0,
      });

      // 2. Reversed timestamps call (endedAt < startedAt)
      const now = Date.now();
      const reversedCall = await createCall('COMPLETED', 0, new Date(now), new Date(now - 30000));
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: reversedCall.id,
        amountCredits: 10.0,
      });

      // 3. Normal 45s call (30s block rounding -> 60s billable = 6.0 credits @ 6/min)
      const normalCall = await createCall('COMPLETED', 45, new Date(now - 45000), new Date(now));
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: normalCall.id,
        amountCredits: 10.0,
      });

      // Run recovery
      await walletService.reconcileTerminalCallReservations(50);

      // Verify Unanswered call was RELEASED with 0 charge
      const unRes = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: unansweredCall.id } });
      expect(unRes.status).toBe(ReservationStatus.CANCELLED);
      expect(Number(unRes.settledAmount)).toBe(0);

      // Verify Reversed timestamps call was RELEASED with 0 charge (not charged!)
      const revRes = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: reversedCall.id } });
      expect(revRes.status).toBe(ReservationStatus.CANCELLED);
      expect(Number(revRes.settledAmount)).toBe(0);

      // Verify Normal 45s call was SETTLED with 60s billable block
      const normRes = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: normalCall.id } });
      expect(normRes.status).toBe(ReservationStatus.SETTLED);
      expect(Number(normRes.settledAmount)).toBe(6.0); // 45s rounded to 60s block
    });
  });

  describe('Stage 3 — Crash Windows & Partial Failure Boundaries', () => {
    it('Rolls back cleanly if database transaction throws during settlement', async () => {
      const call = await createCall('COMPLETED', 30);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      const initialWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: testWalletId } });
      const initialBalance = Number(initialWallet.balanceCredits);

      // Simulate an unhandled database error during transaction by passing invalid non-existent wallet
      await expect(
        walletService.settleCall({
          callId: call.id,
          durationSeconds: 30,
          ratePerMinute: 6.0,
          organizationId: crypto.randomUUID(), // Throws CROSS_TENANT_ACCESS_DENIED
        })
      ).rejects.toThrow();

      // Ensure no balance change, reservation remains HELD
      const postWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: testWalletId } });
      expect(Number(postWallet.balanceCredits)).toBe(initialBalance);

      const reservation = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      expect(reservation.status).toBe(ReservationStatus.HELD);
    });

    it('Recovers terminal call with outstanding reservation after cold in-memory restart', async () => {
      const call = await createCall('COMPLETED', 50);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      // Cold simulated restart: create fresh TelephonyService & Gateway instances (RAM is empty)
      const freshTelephonyService = new TelephonyService(prisma, walletService);

      // Recovery triggers on retry of disconnect webhook
      const rawBody = Buffer.from(
        JSON.stringify({
          eventType: 'call.disconnected',
          eventId: `evt-cold-${Date.now()}`,
          carrierCallId: call.carrierCallId,
          duration: 50,
        })
      );
      const headers = createSignedHeaders(rawBody);

      const result = await freshTelephonyService.handleWebhook(rawBody, headers);
      expect(result.accepted).toBe(true);

      // Reservation must be settled with 60s billable block (6.0 credits)
      const res = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: call.id } });
      expect(res.status).toBe(ReservationStatus.SETTLED);
      expect(Number(res.settledAmount)).toBe(6.0);
    });
  });

  describe('Stage 4 — Webhook Idempotency & Conflict Quarantine', () => {
    it('Detects and rejects reuse of the same event ID with a conflicting payload hash', async () => {
      const call = await createCall('IN_PROGRESS');
      const eventId = `evt-tamper-${Date.now()}`;

      // First webhook delivery
      const rawBody1 = Buffer.from(
        JSON.stringify({
          eventType: 'call.answered',
          eventId,
          carrierCallId: call.carrierCallId,
          timestamp: Date.now(),
        })
      );
      const headers1 = createSignedHeaders(rawBody1);

      const res1 = await telephonyService.handleWebhook(rawBody1, headers1);
      expect(res1.accepted).toBe(true);
      expect(res1.duplicate).toBe(false);

      // Duplicate delivery with IDENTICAL payload and refreshed signature header -> duplicate: true
      const nowSec = Math.floor(Date.now() / 1000);
      const headersRetry = {
        'x-auris-signature': telephonyService.verifier.formatHeader(rawBody1, nowSec + 1),
        'content-type': 'application/json',
      };
      const resDuplicate = await telephonyService.handleWebhook(rawBody1, headersRetry);
      expect(resDuplicate.accepted).toBe(true);
      expect(resDuplicate.duplicate).toBe(true);

      // Tampered / conflicting delivery reusing the SAME eventId with DIFFERENT payload
      const rawBodyTampered = Buffer.from(
        JSON.stringify({
          eventType: 'call.disconnected', // Different event type and body!
          eventId,
          carrierCallId: call.carrierCallId,
          reason: 'FORGED_PAYLOAD',
        })
      );
      const headersTampered = {
        'x-auris-signature': telephonyService.verifier.formatHeader(rawBodyTampered, nowSec + 2),
        'content-type': 'application/json',
      };

      await expect(telephonyService.handleWebhook(rawBodyTampered, headersTampered)).rejects.toThrowError(
        /reused with conflicting payload hash/
      );
    });

    it('Retried or out-of-order webhook events do not revive terminal calls', async () => {
      const call = await createCall('COMPLETED', 60);

      // Out-of-order call.answered arrives for already COMPLETED call
      const rawBody = Buffer.from(
        JSON.stringify({
          eventType: 'call.answered',
          eventId: `evt-revive-${Date.now()}`,
          carrierCallId: call.carrierCallId,
        })
      );
      const headers = createSignedHeaders(rawBody);

      await telephonyService.handleWebhook(rawBody, headers);

      // Call status must remain COMPLETED, not revived to IN_PROGRESS
      const callAfter = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
      expect(callAfter.status).toBe('COMPLETED');
    });
  });

  describe('Stage 5 — Recovery Worker Hardening', () => {
    it('Processes reservations in FIFO order (createdAt: asc) avoiding starvation', async () => {
      // Drain any existing terminal reservations first for this test organization
      await walletService.reconcileTerminalCallReservations(100, testOrgId);

      // Create 3 terminal calls with reservations staggered in time
      const call1 = await createCall('COMPLETED', 30);
      const call2 = await createCall('COMPLETED', 30);
      const call3 = await createCall('COMPLETED', 30);

      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call1.id,
        amountCredits: 10.0,
      });
      await new Promise((r) => setTimeout(r, 10));

      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call2.id,
        amountCredits: 10.0,
      });
      await new Promise((r) => setTimeout(r, 10));

      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call3.id,
        amountCredits: 10.0,
      });

      // Run sweeper with limit = 1 on this test organization
      const batch1 = await walletService.reconcileTerminalCallReservations(1, testOrgId);
      expect(batch1.length).toBe(1);
      expect(batch1[0].callId).toBe(call1.id); // First created is reconciled first

      const batch2 = await walletService.reconcileTerminalCallReservations(1, testOrgId);
      expect(batch2.length).toBe(1);
      expect(batch2[0].callId).toBe(call2.id); // Second is reconciled second
    });

    it('Safely releases expired orphaned reservations with no underlying Call record', async () => {
      const fakeCallId = crypto.randomUUID();

      // Create an isolated organization and wallet for orphan release test
      const orphanOrg = await prisma.organization.create({
        data: {
          name: `Orphan Org ${Date.now()}`,
          slug: `orphan-${Date.now()}`,
        },
      });

      const orphanWallet = await prisma.wallet.create({
        data: {
          organizationId: orphanOrg.id,
          balanceCredits: 100.0,
          reservedCredits: 15.0,
        },
      });

      // Create an orphaned reservation whose hold expires in the past
      await prisma.walletReservation.create({
        data: {
          walletId: orphanWallet.id,
          callId: fakeCallId,
          reservedAmount: 15.0,
          status: ReservationStatus.HELD,
          expiresAt: new Date(Date.now() - 60000), // Expired 1 minute ago
        },
      });

      // Run recovery sweeper
      await walletService.reconcileTerminalCallReservations(50);

      // Orphaned reservation must be cancelled and hold released back to wallet
      const res = await prisma.walletReservation.findUniqueOrThrow({ where: { callId: fakeCallId } });
      expect(res.status).toBe(ReservationStatus.CANCELLED);

      const postWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: orphanWallet.id } });
      expect(Number(postWallet.reservedCredits)).toBe(0.0);
    });

    it('Multiple concurrent recovery workers process pending effects safely without duplicate charges', async () => {
      const call = await createCall('COMPLETED', 60);
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: call.id,
        amountCredits: 10.0,
      });

      // Run 3 recovery workers simultaneously
      const results = await Promise.all([
        walletService.reconcileTerminalCallReservations(50),
        walletService.reconcileTerminalCallReservations(50),
        walletService.reconcileTerminalCallReservations(50),
      ]);

      // Exactly 1 settlement was executed across all workers
      const totalSettled = results.flat().filter((r) => r.callId === call.id && r.status === 'SETTLED');
      expect(totalSettled.length).toBe(1);

      // Exactly 1 ledger transaction created
      const ledgerCount = await prisma.creditTransaction.count({
        where: { referenceId: call.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(ledgerCount).toBe(1);
    });
  });
});
