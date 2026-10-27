import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Role, ReservationStatus } from '@auris/database';
import { buildServer } from '../src/server.js';
import { WalletService } from '../src/modules/wallets/wallet.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { config } from '../src/config.js';
import { FastifyInstance } from 'fastify';

describe('Auris Priority 2 & 3: Authorization, Carrier Callbacks & Wallet Integrity Tests', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let walletService: WalletService;

  beforeAll(async () => {
    prisma = new PrismaClient();
    walletService = new WalletService(prisma);
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('1. Cross-Tenant Settlement & Release Isolation (Negative Authorization Tests)', () => {
    let tokenOrgA: string;
    let orgAId: string;
    let tokenOrgB: string;
    let orgBId: string;
    const orgACallId = `call-org-a-${Date.now()}`;

    beforeAll(async () => {
      // Organization A
      const regA = await AuthService.registerUser({
        email: `isolation-a-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'User Org A',
        organizationName: `Org A Isolation ${Date.now()}`,
      });
      orgAId = regA.org.id;
      tokenOrgA = app.jwt.sign({
        userId: regA.user.id,
        email: regA.user.email,
        organizationId: regA.org.id,
        role: Role.OWNER,
      });

      // Organization B
      const regB = await AuthService.registerUser({
        email: `isolation-b-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'User Org B',
        organizationName: `Org B Isolation ${Date.now()}`,
      });
      orgBId = regB.org.id;
      tokenOrgB = app.jwt.sign({
        userId: regB.user.id,
        email: regB.user.email,
        organizationId: regB.org.id,
        role: Role.OWNER,
      });

      // Create a valid reservation in Org A
      await walletService.createReservation({
        organizationId: orgAId,
        callId: orgACallId,
        amountCredits: 15.0,
      });
    });

    it('strictly forbids User B (Org B) from settling Org A reservation with 403 CROSS_TENANT_ACCESS_DENIED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/settle',
        headers: {
          authorization: `Bearer ${tokenOrgB}`,
        },
        payload: {
          callId: orgACallId,
          durationSeconds: 60,
          ratePerMinute: 5.0,
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('CROSS_TENANT_ACCESS_DENIED');

      // Verify Org A wallet and reservation are completely intact and untouched
      const balanceOrgA = await walletService.getWalletBalance(orgAId);
      expect(balanceOrgA.balanceCredits).toBe(50.0);
      expect(balanceOrgA.reservedCredits).toBe(15.0);

      const reservation = await prisma.walletReservation.findUnique({
        where: { callId: orgACallId },
      });
      expect(reservation?.status).toBe(ReservationStatus.HELD);
    });

    it('strictly forbids User B (Org B) from releasing/cancelling Org A reservation with 403 CROSS_TENANT_ACCESS_DENIED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/release',
        headers: {
          authorization: `Bearer ${tokenOrgB}`,
        },
        payload: {
          callId: orgACallId,
          reason: 'Malicious cancellation attempt',
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('CROSS_TENANT_ACCESS_DENIED');

      // Verify reservation in Org A is still HELD
      const reservation = await prisma.walletReservation.findUnique({
        where: { callId: orgACallId },
      });
      expect(reservation?.status).toBe(ReservationStatus.HELD);
    });

    it('strictly forbids User B (Org B) from extending Org A reservation with 403 CROSS_TENANT_ACCESS_DENIED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/reservations/extend',
        headers: {
          authorization: `Bearer ${tokenOrgB}`,
        },
        payload: {
          callId: orgACallId,
          additionalCredits: 10.0,
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('CROSS_TENANT_ACCESS_DENIED');

      // Verify Org A reservation amount was untouched
      const reservation = await prisma.walletReservation.findUnique({
        where: { callId: orgACallId },
      });
      expect(Number(reservation?.reservedAmount)).toBe(15.0);
    });

    it('allows User A (legitimate owner) to settle their own call', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/settle',
        headers: {
          authorization: `Bearer ${tokenOrgA}`,
        },
        payload: {
          callId: orgACallId,
          durationSeconds: 60,
          ratePerMinute: 5.0,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.status).toBe('SETTLED');
      expect(data.settledAmount).toBe(5.0);
    });
  });

  describe('2. RBAC Role Restrictions on Wallet & Agent Creation', () => {
    let memberToken: string;
    let ownerToken: string;
    let orgId: string;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `rbac-owner-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Org Owner',
        organizationName: `RBAC Test Org ${Date.now()}`,
      });
      orgId = reg.org.id;
      ownerToken = app.jwt.sign({
        userId: reg.user.id,
        email: reg.user.email,
        organizationId: reg.org.id,
        role: Role.OWNER,
      });

      // Create a MEMBER user
      const memberUser = await prisma.user.create({
        data: {
          email: `rbac-member-${Date.now()}@auris.local`,
          name: 'Regular Member',
          passwordHash: 'dummy',
        },
      });
      await prisma.membership.create({
        data: {
          userId: memberUser.id,
          organizationId: orgId,
          role: Role.MEMBER,
        },
      });

      memberToken = app.jwt.sign({
        userId: memberUser.id,
        email: memberUser.email,
        organizationId: orgId,
        role: Role.MEMBER,
      });
    });

    it('rejects pre-call reservation creation by MEMBER with 403 FORBIDDEN', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/wallets/${orgId}/reservations`,
        headers: {
          authorization: `Bearer ${memberToken}`,
        },
        payload: {
          callId: `member-call-${Date.now()}`,
          amountCredits: 10.0,
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('FORBIDDEN');
    });

    it('rejects agent definition creation by MEMBER with 403 FORBIDDEN', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: {
          authorization: `Bearer ${memberToken}`,
        },
        payload: {
          name: 'Unauthorized Agent',
          promptTemplate: 'You are an agent',
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('FORBIDDEN');
    });

    it('allows OWNER to create agent definition', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
        payload: {
          name: 'Authorized Sales Agent',
          promptTemplate: 'You are a professional real estate sales qualifier',
        },
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data.name).toBe('Authorized Sales Agent');
    });
  });

  describe('3. Dedicated Carrier Webhook Verification & Separation', () => {
    let testOrgId: string;
    const carrierCallId = `carrier-call-${Date.now()}`;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `carrier-test-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Carrier Test User',
        organizationName: `Carrier Org ${Date.now()}`,
      });
      testOrgId = reg.org.id;

      await walletService.createReservation({
        organizationId: testOrgId,
        callId: carrierCallId,
        amountCredits: 15.0,
      });
    });

    it('rejects unauthenticated carrier webhook with 401 INVALID_CARRIER_SIGNATURE', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/webhooks/carrier',
        payload: {
          carrierCallId: 'plivo-123',
          callId: carrierCallId,
          eventType: 'call.completed',
          durationSeconds: 45,
        },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('INVALID_CARRIER_SIGNATURE');
    });

    it('accepts carrier webhook with valid signature and settles the call', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/webhooks/carrier',
        headers: {
          'x-auris-signature': 'mock-valid-signature',
        },
        payload: {
          carrierCallId: 'plivo-123',
          callId: carrierCallId,
          eventType: 'call.completed',
          durationSeconds: 45,
          ratePerMinute: 5.0,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.status).toBe('SETTLED');
      expect(data.settledAmount).toBe(5.0);
    });

    it('accepts internal voice runtime callback with trusted internal secret for failed call', async () => {
      const failedCallId = `failed-call-${Date.now()}`;
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: failedCallId,
        amountCredits: 10.0,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/webhooks/carrier',
        headers: {
          'x-auris-internal-secret': config.JWT_SECRET,
        },
        payload: {
          carrierCallId: 'plivo-failed-123',
          callId: failedCallId,
          eventType: 'call.busy',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.status).toBe('CANCELLED');
      expect(data.releasedAmount).toBe(10.0);
    });
  });

  describe('4. Wallet Financial Integrity & Overdraft Prevention', () => {
    let overdraftOrgId: string;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `overdraft-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Overdraft User',
        organizationName: `Overdraft Org ${Date.now()}`,
      });
      overdraftOrgId = reg.org.id;

      // Set balance to exactly ₹10.00
      await prisma.wallet.update({
        where: { organizationId: overdraftOrgId },
        data: { balanceCredits: 10.0, reservedCredits: 0.0 },
      });
    });

    it('prevents balance from going negative when call cost exceeds total balance', async () => {
      const longCallId = `long-call-${Date.now()}`;

      // Reserve ₹10.00 (all available funds)
      await walletService.createReservation({
        organizationId: overdraftOrgId,
        callId: longCallId,
        amountCredits: 10.0,
      });

      // Call lasted 6 minutes @ ₹5/min = ₹30.00 charge (exceeds balance by ₹20.00)
      const settlement = await walletService.settleCall({
        callId: longCallId,
        durationSeconds: 360,
        ratePerMinute: 5.0,
      });

      expect(settlement.status).toBe('SETTLED');
      // Settled amount was capped at the total available balance (₹10.00)
      expect(settlement.settledAmount).toBe(10.0);
      expect(settlement.unsettledOverdraft).toBe(20.0);
      // New balance is strictly 0.0, NEVER negative
      expect(settlement.newBalance).toBe(0.0);

      // Verify in database that balance_credits is >= 0 and reserved_credits is 0
      const wallet = await walletService.getWalletBalance(overdraftOrgId);
      expect(wallet.balanceCredits).toBe(0.0);
      expect(wallet.reservedCredits).toBe(0.0);
      expect(wallet.availableCredits).toBe(0.0);

      // Transparent reporting: Verify unpaidAmount is stored on the DB reservation row
      const savedRes = await prisma.walletReservation.findUniqueOrThrow({
        where: { callId: longCallId },
      });
      expect(Number(savedRes.unpaidAmount)).toBe(20.0);
      expect(Number(savedRes.settledAmount)).toBe(10.0);
      expect(settlement.isPartialSettlement).toBe(true);
    });

    it('atomically extends reservation mid-call when sufficient funds exist via POST /v1/wallets/reservations/extend', async () => {
      const callId = `extend-midcall-${Date.now()}`;
      const solventOrgReg = await AuthService.registerUser({
        email: `extend-user-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Extend User',
        organizationName: `Extend Org ${Date.now()}`,
      });
      const orgId = solventOrgReg.org.id;
      const userToken = app.jwt.sign({
        userId: solventOrgReg.user.id,
        email: solventOrgReg.user.email,
        organizationId: orgId,
        role: Role.OWNER,
      });

      // Initial reservation: ₹10.00
      await walletService.createReservation({
        organizationId: orgId,
        callId,
        amountCredits: 10.0,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/reservations/extend',
        headers: {
          authorization: `Bearer ${userToken}`,
        },
        payload: {
          callId,
          additionalCredits: 15.0,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.extended).toBe(true);
      expect(data.totalReserved).toBe(25.0);

      const wallet = await walletService.getWalletBalance(orgId);
      expect(wallet.reservedCredits).toBe(25.0);
      expect(wallet.availableCredits).toBe(25.0); // 50 - 25 = 25
    });

    it('rejects mid-call reservation extension with 402 and TERMINATE_CALL when balance is insufficient, preventing provider debt', async () => {
      const callId = `exhausted-extend-${Date.now()}`;
      const tightOrgReg = await AuthService.registerUser({
        email: `tight-user-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Tight User',
        organizationName: `Tight Org ${Date.now()}`,
      });
      const orgId = tightOrgReg.org.id;
      const userToken = app.jwt.sign({
        userId: tightOrgReg.user.id,
        email: tightOrgReg.user.email,
        organizationId: orgId,
        role: Role.OWNER,
      });

      // Set balance to ₹15.00
      await prisma.wallet.update({
        where: { organizationId: orgId },
        data: { balanceCredits: 15.0, reservedCredits: 0.0 },
      });

      // Hold ₹10.00 (leaves ₹5.00 available)
      await walletService.createReservation({
        organizationId: orgId,
        callId,
        amountCredits: 10.0,
      });

      // Attempt to extend by ₹10.00 (needs ₹10.00, only ₹5.00 available)
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/reservations/extend',
        headers: {
          authorization: `Bearer ${userToken}`,
        },
        payload: {
          callId,
          additionalCredits: 10.0,
        },
      });

      expect(response.statusCode).toBe(402);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('INSUFFICIENT_FUNDS_FOR_EXTENSION');
      expect(data.action).toBe('TERMINATE_CALL');
      expect(data.extended).toBe(false);

      // Verify wallet reserved credits did not increase
      const wallet = await walletService.getWalletBalance(orgId);
      expect(wallet.reservedCredits).toBe(10.0);
      expect(wallet.availableCredits).toBe(5.0);
    });

    it('handles long call that exceeds hold when wallet has sufficient unreserved funds', async () => {
      const solventOrgId = (
        await AuthService.registerUser({
          email: `solvent-${Date.now()}@auris.local`,
          password: 'password123',
          name: 'Solvent User',
          organizationName: `Solvent Org ${Date.now()}`,
        })
      ).org.id;

      // Balance ₹50.00
      await prisma.wallet.update({
        where: { organizationId: solventOrgId },
        data: { balanceCredits: 50.0, reservedCredits: 0.0 },
      });

      const callId = `extended-call-${Date.now()}`;
      // Hold of ₹10.00
      await walletService.createReservation({
        organizationId: solventOrgId,
        callId,
        amountCredits: 10.0,
      });

      // Call lasted 4 minutes = ₹20.00 (exceeds ₹10.00 hold, but wallet has ₹50.00)
      const settlement = await walletService.settleCall({
        callId,
        durationSeconds: 240,
        ratePerMinute: 5.0,
      });

      expect(settlement.status).toBe('SETTLED');
      expect(settlement.settledAmount).toBe(20.0);
      expect(settlement.unsettledOverdraft).toBe(0.0);
      expect(settlement.newBalance).toBe(30.0);

      const wallet = await walletService.getWalletBalance(solventOrgId);
      expect(wallet.balanceCredits).toBe(30.0);
      expect(wallet.reservedCredits).toBe(0.0);
    });
  });

  describe('5. Concurrent Settlements & Expiry Recovery', () => {
    let testOrgId: string;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `concurrent-settle-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Concurrent Settle User',
        organizationName: `Concurrent Settle Org ${Date.now()}`,
      });
      testOrgId = reg.org.id;

      await prisma.wallet.update({
        where: { organizationId: testOrgId },
        data: { balanceCredits: 50.0, reservedCredits: 0.0 },
      });
    });

    it('processes concurrent settlement attempts for the same call without double deduction', async () => {
      const callId = `race-settle-${Date.now()}`;
      await walletService.createReservation({
        organizationId: testOrgId,
        callId,
        amountCredits: 10.0,
      });

      // Launch 2 parallel settlements for the same call
      const [res1, res2] = await Promise.all([
        walletService.settleCall({ callId, durationSeconds: 60, ratePerMinute: 5.0 }),
        walletService.settleCall({ callId, durationSeconds: 60, ratePerMinute: 5.0 }),
      ]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain('SETTLED');
      expect(statuses).toContain('ALREADY_SETTLED');

      // Balance was deducted only once (₹50 - ₹5 = ₹45)
      const wallet = await walletService.getWalletBalance(testOrgId);
      expect(wallet.balanceCredits).toBe(45.0);
      expect(wallet.reservedCredits).toBe(0.0);
    });

    it('automatically recovers expired reservations and restores available balance', async () => {
      const expiredCallId = `expired-hold-${Date.now()}`;

      // Create a reservation that expired 1 hour ago
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: testOrgId } });
      await prisma.wallet.update({
        where: { id: wallet.id },
        data: { reservedCredits: { increment: 15.0 } },
      });

      await prisma.walletReservation.create({
        data: {
          walletId: wallet.id,
          callId: expiredCallId,
          reservedAmount: 15.0,
          status: ReservationStatus.HELD,
          expiresAt: new Date(Date.now() - 3600 * 1000), // 1 hour in the past
        },
      });

      const beforeRecovery = await walletService.getWalletBalance(testOrgId);
      expect(beforeRecovery.reservedCredits).toBe(15.0);

      // Run reconciliation
      const recovered = await walletService.reconcileExpiredReservations(new Date());
      expect(recovered.length).toBeGreaterThanOrEqual(1);
      expect(recovered.some((r) => r.callId === expiredCallId)).toBe(true);

      // Verify reserved credits restored to 0.0
      const afterRecovery = await walletService.getWalletBalance(testOrgId);
      expect(afterRecovery.reservedCredits).toBe(0.0);
    });

    it('duplicate expiry recovery is strictly idempotent and causes zero duplicate refunds', async () => {
      // Running reconciliation immediately again yields no reservations to reconcile
      const secondRun = await walletService.reconcileExpiredReservations(new Date());
      expect(secondRun.length).toBe(0);

      // Verify reserved credits remain 0.0 and balance remains unchanged
      const wallet = await walletService.getWalletBalance(testOrgId);
      expect(wallet.reservedCredits).toBe(0.0);
    });

    it('reconciles expired reservations via HTTP POST /v1/wallets/reconcile-expired', async () => {
      const expiredCallId = `expired-api-${Date.now()}`;
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: testOrgId } });
      await prisma.wallet.update({
        where: { id: wallet.id },
        data: { reservedCredits: { increment: 10.0 } },
      });

      await prisma.walletReservation.create({
        data: {
          walletId: wallet.id,
          callId: expiredCallId,
          reservedAmount: 10.0,
          status: ReservationStatus.HELD,
          expiresAt: new Date(Date.now() - 10000), // 10s in the past
        },
      });

      // Invoke endpoint with internal worker secret
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallets/reconcile-expired',
        headers: {
          'x-auris-internal-secret': config.JWT_SECRET,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.reconciledCount).toBeGreaterThanOrEqual(1);

      const resRow = await prisma.walletReservation.findUnique({ where: { callId: expiredCallId } });
      expect(resRow?.status).toBe(ReservationStatus.CANCELLED);
    });
  });

  describe('6. Database Check Constraints & Invariant Enforcement', () => {
    let checkOrgId: string;
    let walletId: string;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `db-invariants-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Invariant Test User',
        organizationName: `Invariant Test Org ${Date.now()}`,
      });
      checkOrgId = reg.org.id;
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: checkOrgId } });
      walletId = wallet.id;
    });

    it('rejects direct SQL update setting balance_credits < 0 with check constraint violation', async () => {
      await expect(
        prisma.$executeRawUnsafe(`UPDATE wallets SET balance_credits = -5.0000 WHERE id = '${walletId}'::uuid`)
      ).rejects.toThrow(/wallets_balance_credits_non_negative/);
    });

    it('rejects direct SQL update setting reserved_credits < 0 with check constraint violation', async () => {
      await expect(
        prisma.$executeRawUnsafe(`UPDATE wallets SET reserved_credits = -2.5000 WHERE id = '${walletId}'::uuid`)
      ).rejects.toThrow(/wallets_reserved_credits_non_negative/);
    });

    it('rejects direct SQL insert with reserved_amount <= 0 on wallet_reservations', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO wallet_reservations (id, wallet_id, call_id, reserved_amount, status, expires_at, created_at, updated_at, unpaid_amount)
          VALUES (gen_random_uuid(), '${walletId}'::uuid, 'invalid-res-${Date.now()}', -10.0000, 'HELD', NOW() + INTERVAL '1 hour', NOW(), NOW(), 0.0000)
        `)
      ).rejects.toThrow(/wallet_reservations_reserved_amount_positive/);
    });

    it('rejects direct SQL insert with unpaid_amount < 0 on wallet_reservations', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO wallet_reservations (id, wallet_id, call_id, reserved_amount, status, expires_at, created_at, updated_at, unpaid_amount)
          VALUES (gen_random_uuid(), '${walletId}'::uuid, 'invalid-unpaid-${Date.now()}', 10.0000, 'HELD', NOW() + INTERVAL '1 hour', NOW(), NOW(), -5.0000)
        `)
      ).rejects.toThrow(/wallet_reservations_unpaid_amount_non_negative/);
    });
  });
});
