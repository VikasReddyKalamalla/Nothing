import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Role } from '@auris/database';
import { WalletService } from '../src/modules/wallets/wallet.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';

describe('Auris Phase 1: Billing Invariants, Ledger & Multi-Tenancy Tests', () => {
  let prisma: PrismaClient;
  let walletService: WalletService;
  let app: FastifyInstance;

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

  describe('1. Billing Boundary & Tariff Calculation Invariants', () => {
    it('calculates 0 charge for 0 duration', () => {
      const calc = WalletService.calculateCallCharge(0, 5.0, 30);
      expect(calc.billableSeconds).toBe(0);
      expect(calc.chargeAmount).toBe(0);
    });

    it('calculates 30s block for sub-30s calls (e.g. 10s and 29s)', () => {
      const calc10 = WalletService.calculateCallCharge(10, 5.0, 30);
      expect(calc10.billableSeconds).toBe(30);
      expect(calc10.chargeAmount).toBe(2.5);

      const calc29 = WalletService.calculateCallCharge(29, 5.0, 30);
      expect(calc29.billableSeconds).toBe(30);
      expect(calc29.chargeAmount).toBe(2.5);

      const calc30 = WalletService.calculateCallCharge(30, 5.0, 30);
      expect(calc30.billableSeconds).toBe(30);
      expect(calc30.chargeAmount).toBe(2.5);
    });

    it('steps up to 60s block immediately at 31s', () => {
      const calc31 = WalletService.calculateCallCharge(31, 5.0, 30);
      expect(calc31.billableSeconds).toBe(60);
      expect(calc31.chargeAmount).toBe(5.0);

      const calc59 = WalletService.calculateCallCharge(59, 5.0, 30);
      expect(calc59.billableSeconds).toBe(60);
      expect(calc59.chargeAmount).toBe(5.0);

      const calc60 = WalletService.calculateCallCharge(60, 5.0, 30);
      expect(calc60.billableSeconds).toBe(60);
      expect(calc60.chargeAmount).toBe(5.0);
    });

    it('handles premium voice tariff rate (₹6.80/min) accurately', () => {
      const calc45 = WalletService.calculateCallCharge(45, 6.8, 30);
      expect(calc45.billableSeconds).toBe(60);
      expect(calc45.chargeAmount).toBe(6.8);
    });
  });

  describe('2. Wallet Solvency & Insufficient Funds Rejection', () => {
    let testOrgId: string;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `solvency-test-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Solvency User',
        organizationName: `Solvency Org ${Date.now()}`,
      });
      testOrgId = reg.org.id;

      // Adjust wallet balance to exactly ₹10.00
      await prisma.wallet.update({
        where: { organizationId: testOrgId },
        data: { balanceCredits: 10.0, reservedCredits: 0.0 },
      });
    });

    it('rejects reservation attempt that exceeds available funds without altering balance', async () => {
      const callId = `call-reject-${Date.now()}`;

      await expect(
        walletService.createReservation({
          organizationId: testOrgId,
          callId,
          amountCredits: 25.0, // Exceeds ₹10.0 balance
        })
      ).rejects.toThrow('INSUFFICIENT_FUNDS');

      // Verify balances remained completely untouched
      const balance = await walletService.getWalletBalance(testOrgId);
      expect(balance.balanceCredits).toBe(10.0);
      expect(balance.reservedCredits).toBe(0.0);
      expect(balance.availableCredits).toBe(10.0);
    });
  });

  describe('3. Concurrent Reservation Contention (No Overspending)', () => {
    let testOrgId: string;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `concurrency-test-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Concurrency User',
        organizationName: `Concurrency Org ${Date.now()}`,
      });
      testOrgId = reg.org.id;

      // Set balance to exactly ₹30.00
      await prisma.wallet.update({
        where: { organizationId: testOrgId },
        data: { balanceCredits: 30.0, reservedCredits: 0.0 },
      });
    });

    it('prevents concurrent calls from exceeding available balance', async () => {
      // 3 concurrent attempts to reserve ₹15.00 each on a ₹30.00 balance
      const callIds = [`concurrent-1-${Date.now()}`, `concurrent-2-${Date.now()}`, `concurrent-3-${Date.now()}`];

      const results = await Promise.allSettled(
        callIds.map((cid) =>
          walletService.createReservation({
            organizationId: testOrgId,
            callId: cid,
            amountCredits: 15.0,
          })
        )
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly 2 reservations must succeed and exactly 1 must fail with INSUFFICIENT_FUNDS
      expect(fulfilled.length).toBe(2);
      expect(rejected.length).toBe(1);

      // Verify wallet reserved amount is exactly ₹30.00, available is ₹0.00
      const balance = await walletService.getWalletBalance(testOrgId);
      expect(balance.balanceCredits).toBe(30.0);
      expect(balance.reservedCredits).toBe(30.0);
      expect(balance.availableCredits).toBe(0.0);
    });
  });

  describe('4. Idempotent Settlement & Double-Charge Prevention', () => {
    let testOrgId: string;
    const testCallId = `settle-call-${Date.now()}`;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `settle-test-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Settle User',
        organizationName: `Settle Org ${Date.now()}`,
      });
      testOrgId = reg.org.id;

      // Set balance to ₹50.00
      await prisma.wallet.update({
        where: { organizationId: testOrgId },
        data: { balanceCredits: 50.0, reservedCredits: 0.0 },
      });

      // Reserve ₹15.00 for call
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: testCallId,
        amountCredits: 15.0,
      });
    });

    it('settles call and deducts charge, releasing held reservation', async () => {
      // Call lasted 45s @ ₹5/min -> 60s billable = ₹5.00
      const settlement = await walletService.settleCall({
        callId: testCallId,
        durationSeconds: 45,
        ratePerMinute: 5.0,
      });

      expect(settlement.status).toBe('SETTLED');
      expect(settlement.settledAmount).toBe(5.0);
      expect(settlement.newBalance).toBe(45.0);

      const balance = await walletService.getWalletBalance(testOrgId);
      expect(balance.balanceCredits).toBe(45.0);
      expect(balance.reservedCredits).toBe(0.0);
      expect(balance.availableCredits).toBe(45.0);
    });

    it('prevents double charging on duplicate settlement requests', async () => {
      // Duplicate webhook execution with same callId
      const duplicate = await walletService.settleCall({
        callId: testCallId,
        durationSeconds: 45,
        ratePerMinute: 5.0,
      });

      expect(duplicate.status).toBe('ALREADY_SETTLED');

      // Balance must NOT have been deducted a second time
      const balance = await walletService.getWalletBalance(testOrgId);
      expect(balance.balanceCredits).toBe(45.0);
      expect(balance.reservedCredits).toBe(0.0);
      expect(balance.availableCredits).toBe(45.0);
    });
  });

  describe('5. Unanswered Calls & Unused Reservation Release', () => {
    let testOrgId: string;
    const unansweredCallId = `unanswered-call-${Date.now()}`;

    beforeAll(async () => {
      const reg = await AuthService.registerUser({
        email: `unanswered-test-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'Unanswered User',
        organizationName: `Unanswered Org ${Date.now()}`,
      });
      testOrgId = reg.org.id;

      // Balance ₹50.00
      await prisma.wallet.update({
        where: { organizationId: testOrgId },
        data: { balanceCredits: 50.0, reservedCredits: 0.0 },
      });

      // Create hold of ₹15.00
      await walletService.createReservation({
        organizationId: testOrgId,
        callId: unansweredCallId,
        amountCredits: 15.0,
      });
    });

    it('releases hold completely when call is unanswered/busy with ₹0 net charge', async () => {
      const release = await walletService.releaseReservation({
        callId: unansweredCallId,
        reason: 'Callee busy / no answer',
      });

      expect(release.status).toBe('CANCELLED');
      expect(release.releasedAmount).toBe(15.0);

      // Verify wallet balance is intact at ₹50.00 and reservedCredits is 0.00
      const balance = await walletService.getWalletBalance(testOrgId);
      expect(balance.balanceCredits).toBe(50.0);
      expect(balance.reservedCredits).toBe(0.0);
      expect(balance.availableCredits).toBe(50.0);
    });
  });

  describe('6. Multi-Tenant Authorization & Cross-Tenant Access Protection', () => {
    let tokenOrgA: string;
    let orgAId: string;
    let orgBId: string;

    beforeAll(async () => {
      // User A in Org A
      const regA = await AuthService.registerUser({
        email: `org-a-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'User A',
        organizationName: `Org A ${Date.now()}`,
      });
      orgAId = regA.org.id;
      tokenOrgA = app.jwt.sign({
        userId: regA.user.id,
        email: regA.user.email,
        organizationId: regA.org.id,
        role: Role.OWNER,
      });

      // User B in Org B
      const regB = await AuthService.registerUser({
        email: `org-b-${Date.now()}@auris.local`,
        password: 'password123',
        name: 'User B',
        organizationName: `Org B ${Date.now()}`,
      });
      orgBId = regB.org.id;
    });

    it('allows User A to access Org A wallet balance', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/wallets/${orgAId}/balance`,
        headers: {
          authorization: `Bearer ${tokenOrgA}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.organizationId).toBe(orgAId);
    });

    it('strictly forbids User A from accessing Org B wallet balance (Cross-Tenant Denial)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/wallets/${orgBId}/balance`,
        headers: {
          authorization: `Bearer ${tokenOrgA}`,
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('CROSS_TENANT_ACCESS_DENIED');
    });
  });
});
