import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { PrismaClient, CallStatus, ReservationStatus, WalletTxType } from '@auris/database';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';
import { MockWebhookSignatureVerifier } from '@auris/runtime';
import { activeTelephonyService } from '../src/modules/telephony/telephony.routes.js';
import { WalletService } from '../src/modules/wallets/wallet.service.js';
import { config } from '../src/config.js';

describe('Phase 4.1.2: Durable Effects and Billing Recovery Audit', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let walletService: WalletService;
  let orgId: string;
  let walletId: string;
  let agentId: string;
  let callId: string;
  let carrierCallId: string;

  const verifier = new MockWebhookSignatureVerifier({
    secret: config.MOCK_WEBHOOK_SECRET,
    toleranceSeconds: 300,
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    walletService = new WalletService(prisma);
    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });

    const org = await prisma.organization.create({
      data: {
        name: `Billing Recovery Org ${Date.now()}`,
        slug: `billing-recovery-org-${Date.now()}`,
      },
    });
    orgId = org.id;

    const wallet = await prisma.wallet.create({
      data: {
        organizationId: orgId,
        balanceCredits: 100.0,
        reservedCredits: 0.0,
      },
    });
    walletId = wallet.id;

    const agent = await prisma.agent.create({
      data: {
        organizationId: orgId,
        name: 'Billing Agent',
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
    // Reset wallet to clean baseline: ₹100.00 balance, ₹0.00 reserved
    await prisma.wallet.update({
      where: { id: walletId },
      data: { balanceCredits: 100.0, reservedCredits: 0.0 },
    });

    carrierCallId = `carrier-leg-billing-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
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

  it('Scenario 1 & 2 & 8: Terminal call with outstanding reservation reconciles cleanly after worker crash / process restart', async () => {
    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    expect(telephonyService).toBeDefined();

    // 1. Create a hold of ₹10.00 for callId before carrier connected
    await walletService.createReservation({
      organizationId: orgId,
      callId,
      amountCredits: 10.0,
      holdDurationMinutes: 60,
    });

    const walletAfterHold = await prisma.wallet.findUnique({ where: { id: walletId } });
    expect(Number(walletAfterHold?.reservedCredits)).toBe(10.0);
    expect(Number(walletAfterHold?.balanceCredits)).toBe(100.0);

    // 2. Simulate worker crash / process restart:
    // Memory is wiped (no active CallSession in RAM), but Call.status was marked COMPLETED with 30s duration
    telephonyService.gateway.unregisterCallMapping(carrierCallId);
    await prisma.call.update({
      where: { id: callId },
      data: {
        status: CallStatus.COMPLETED,
        startedAt: new Date(Date.now() - 30000),
        endedAt: new Date(),
        durationSeconds: 30,
      },
    });

    // Verify the defect state before reconciliation:
    // Call is COMPLETED in DB, but reservation is STILL HELD!
    const unrecoveredRes = await prisma.walletReservation.findUnique({ where: { callId } });
    expect(unrecoveredRes?.status).toBe(ReservationStatus.HELD);

    // 3. Automated Reconciliation runs
    const reconciled = await walletService.reconcileTerminalCallReservations();
    expect(reconciled.length).toBeGreaterThanOrEqual(1);

    // 4. Assert durable database and ledger outcomes:
    // Reservation must be SETTLED
    const settledRes = await prisma.walletReservation.findUnique({ where: { callId } });
    expect(settledRes?.status).toBe(ReservationStatus.SETTLED);
    expect(Number(settledRes?.settledAmount)).toBe(3.0); // 30s @ ₹6.00/min = ₹3.00

    // Wallet balances must reflect settlement: ₹97.00 balance, ₹0.00 reserved
    const finalWallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    expect(Number(finalWallet?.balanceCredits)).toBe(97.0);
    expect(Number(finalWallet?.reservedCredits)).toBe(0.0);

    // Exactly 1 CALL_SETTLEMENT ledger entry created for this call
    const settlements = await prisma.creditTransaction.findMany({
      where: { referenceId: callId, type: WalletTxType.CALL_SETTLEMENT },
    });
    expect(settlements.length).toBe(1);
    expect(Number(settlements[0].amountCredits)).toBe(-3.0);
  });

  it('Scenario 3: Transient wallet settlement failure is safely retryable without duplicate charges', async () => {
    // 1. Create reservation
    await walletService.createReservation({
      organizationId: orgId,
      callId,
      amountCredits: 15.0,
      holdDurationMinutes: 60,
    });

    // 2. Settlement succeeds on first attempt
    const s1 = await walletService.settleCall({
      callId,
      durationSeconds: 60,
      ratePerMinute: 6.0,
      organizationId: orgId,
    });
    expect(s1.status).toBe('SETTLED');
    expect(s1.settledAmount).toBe(6.0);

    // 3. Retry after simulated network disconnect or client timeout
    const s2 = await walletService.settleCall({
      callId,
      durationSeconds: 60,
      ratePerMinute: 6.0,
      organizationId: orgId,
    });
    expect(s2.status).toBe('ALREADY_SETTLED');
    expect(s2.settledAmount).toBe(6.0);

    // 4. Assert ledger invariant: exactly 1 CALL_SETTLEMENT transaction exists
    const txCount = await prisma.creditTransaction.count({
      where: { referenceId: callId, type: WalletTxType.CALL_SETTLEMENT },
    });
    expect(txCount).toBe(1);

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    expect(Number(wallet?.balanceCredits)).toBe(94.0);
    expect(Number(wallet?.reservedCredits)).toBe(0.0);
  });

  it('Scenario 4: Settlement and release requested concurrently serialize safely via row-level locks', async () => {
    // Create reservation
    await walletService.createReservation({
      organizationId: orgId,
      callId,
      amountCredits: 10.0,
      holdDurationMinutes: 60,
    });

    // Fire settleCall and releaseReservation simultaneously on the same call
    const [settleRes, releaseRes] = await Promise.allSettled([
      walletService.settleCall({
        callId,
        durationSeconds: 30,
        ratePerMinute: 6.0,
        organizationId: orgId,
      }),
      walletService.releaseReservation({
        callId,
        reason: 'Concurrent race cancel',
        organizationId: orgId,
      }),
    ]);

    // Exactly one of the two must succeed; the other must be rejected
    const isSettleFulfilled = settleRes.status === 'fulfilled';
    const isReleaseFulfilled = releaseRes.status === 'fulfilled';

    expect(isSettleFulfilled !== isReleaseFulfilled).toBe(true);

    if (isSettleFulfilled) {
      expect((releaseRes as PromiseRejectedResult).reason.message).toMatch(
        /CANNOT_CANCEL_SETTLED_RESERVATION/
      );
    } else {
      expect((settleRes as PromiseRejectedResult).reason.message).toMatch(
        /RESERVATION_ALREADY_CANCELLED/
      );
    }

    // Reservation status is non-conflicting (either SETTLED or CANCELLED, never both)
    const reservation = await prisma.walletReservation.findUnique({ where: { callId } });
    expect([ReservationStatus.SETTLED, ReservationStatus.CANCELLED]).toContain(reservation?.status);

    // Wallet reserved credits must be cleanly released to 0
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    expect(Number(wallet?.reservedCredits)).toBe(0.0);
  });

  it('Scenario 6 & 7: Retry after simulated cold restart reconciles both Call status and outstanding reservation', async () => {
    const telephonyService = activeTelephonyService || (app as any).telephonyService;
    expect(telephonyService).toBeDefined();

    // 1. Create reservation
    await walletService.createReservation({
      organizationId: orgId,
      callId,
      amountCredits: 12.0,
      holdDurationMinutes: 60,
    });

    // 2. Simulate process restart: clear in-memory mapping and active sessions
    telephonyService.gateway.unregisterCallMapping(carrierCallId);

    const eventId = `restart-reconcile-${Date.now()}`;
    const payload = {
      eventId,
      event: 'disconnected',
      carrierCallId,
      timestamp: Math.floor(Date.now() / 1000),
      reason: 'CARRIER_NORMAL_CLEARING',
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const sigHeader = verifier.formatHeader(rawBody);

    // 3. Webhook arrives at restarted process
    const res = await telephonyService.handleWebhook(rawBody, {
      'content-type': 'application/json',
      'x-auris-signature': sigHeader,
    });

    expect(res.accepted).toBe(true);
    expect(res.callId).toBe(callId);

    // 4. Assert durable database convergence:
    // Call status is COMPLETED
    const finalCall = await prisma.call.findUnique({ where: { id: callId } });
    expect(finalCall?.status).toBe(CallStatus.COMPLETED);

    // Reservation was automatically reconciled: CANCELLED (no duration on inbound un-answered)
    const finalRes = await prisma.walletReservation.findUnique({ where: { callId } });
    expect(finalRes?.status).toBe(ReservationStatus.CANCELLED);

    // Wallet reserved credits released back to available balance
    const finalWallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    expect(Number(finalWallet?.reservedCredits)).toBe(0.0);
    expect(Number(finalWallet?.balanceCredits)).toBe(100.0);
  });

  it('Scenario 9 & 10: Multiple concurrent recovery attempts process pending effects without duplicate transactions', async () => {
    // 1. Create a hold for callId
    await walletService.createReservation({
      organizationId: orgId,
      callId,
      amountCredits: 20.0,
      holdDurationMinutes: 60,
    });

    // Mark call as COMPLETED in DB with 60 seconds duration
    await prisma.call.update({
      where: { id: callId },
      data: {
        status: CallStatus.COMPLETED,
        startedAt: new Date(Date.now() - 60000),
        endedAt: new Date(),
        durationSeconds: 60,
      },
    });

    // 2. Fire 3 concurrent recovery workers on the exact same pending reservation
    const [r1, r2, r3] = await Promise.all([
      walletService.reconcileTerminalCallReservations(),
      walletService.reconcileTerminalCallReservations(),
      walletService.reconcileTerminalCallReservations(),
    ]);

    // Total successful settlements across all 3 workers must be exactly 1
    const totalSettled = [...r1, ...r2, ...r3].filter((r: any) => r.status === 'SETTLED');
    expect(totalSettled.length).toBe(1);

    // 3. Ledger verification: exactly 1 credit transaction created
    const transactions = await prisma.creditTransaction.findMany({
      where: { referenceId: callId, type: WalletTxType.CALL_SETTLEMENT },
    });
    expect(transactions.length).toBe(1);
    expect(Number(transactions[0].amountCredits)).toBe(-6.0); // 60s @ ₹6.00/min = ₹6.00

    // 4. Run recovery a second time (idempotency check)
    const rSecondRun = await walletService.reconcileTerminalCallReservations();
    // Must find zero remaining un-reconciled reservations
    const remainingForCall = rSecondRun.filter((r: any) => r.callId === callId);
    expect(remainingForCall.length).toBe(0);

    const finalWallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    expect(Number(finalWallet?.balanceCredits)).toBe(94.0);
    expect(Number(finalWallet?.reservedCredits)).toBe(0.0);
  });
});
