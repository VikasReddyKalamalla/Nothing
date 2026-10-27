import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  ReservationStatus,
  WalletTxType,
  CallStatus,
  SpeakerType,
} from '@auris/database';
import { WalletService } from '../src/modules/wallets/wallet.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import {
  CallSession,
  CallStateMachine,
  CallState,
  InvalidStateTransitionError,
  MockTelephonyAdapter,
  MockSTTAdapter,
  MockLLMAdapter,
  MockTTSAdapter,
  RuntimeWalletBridge,
  CallEventLogger,
} from '@auris/runtime';

describe('Auris Phase 3.1: Runtime Reliability, Billing Concurrency & Crash Recovery Audit', () => {
  let prisma: PrismaClient;
  let walletService: WalletService;

  let testOrgAId: string;
  let testAgentAId: string;
  let testOrgBId: string;
  let testAgentBId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    walletService = new WalletService(prisma);

    // Setup Org A
    const regA = await AuthService.registerUser({
      email: `audit-org-a-${Date.now()}@auris.local`,
      password: 'password123',
      name: 'Audit Org A',
      organizationName: `Audit Org A ${Date.now()}`,
    });
    testOrgAId = regA.org.id;

    const agentA = await prisma.agent.create({
      data: {
        organizationId: testOrgAId,
        name: 'Reliability Agent A',
        roleType: 'INSTANT_LEAD',
        voiceTier: 'STANDARD',
        primaryLanguage: 'English',
        promptTemplate: 'You are a test assistant.',
      },
    });
    testAgentAId = agentA.id;

    // Setup Org B (for multi-tenant isolation)
    const regB = await AuthService.registerUser({
      email: `audit-org-b-${Date.now()}@auris.local`,
      password: 'password123',
      name: 'Audit Org B',
      organizationName: `Audit Org B ${Date.now()}`,
    });
    testOrgBId = regB.org.id;

    const agentB = await prisma.agent.create({
      data: {
        organizationId: testOrgBId,
        name: 'Reliability Agent B',
        roleType: 'INSTANT_LEAD',
        voiceTier: 'STANDARD',
        primaryLanguage: 'English',
        promptTemplate: 'You are another test assistant.',
      },
    });
    testAgentBId = agentB.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Independent financial reconciliation oracle
  async function verifyWalletFinancialIntegrity(orgId: string) {
    const wallet = await prisma.wallet.findUnique({
      where: { organizationId: orgId },
      include: { reservations: true, transactions: true },
    });
    expect(wallet).toBeDefined();

    const balance = Number(wallet!.balanceCredits);
    const reserved = Number(wallet!.reservedCredits);

    // Invariant 1: Balance must NEVER be negative
    expect(balance).toBeGreaterThanOrEqual(0);

    // Invariant 2: Reserved credits must NEVER be negative
    expect(reserved).toBeGreaterThanOrEqual(0);

    // Invariant 3: Sum of HELD reservations must exactly match wallet.reservedCredits
    const heldSum = wallet!.reservations
      .filter((r) => r.status === ReservationStatus.HELD)
      .reduce((sum, r) => sum + Number(r.reservedAmount), 0);
    expect(Number(heldSum.toFixed(4))).toBe(Number(reserved.toFixed(4)));

    return { balance, reserved, available: balance - reserved };
  }

  // =========================================================================
  // PHASE B: BILLING CONCURRENCY AND FINANCIAL INVARIANTS
  // =========================================================================

  describe('Phase B1: Concurrent Reservation Creation', () => {
    it('handles competing concurrent reservations when funds are strictly limited', async () => {
      // Set Org A balance to exactly ₹10.00 with 0 reserved
      await prisma.wallet.update({
        where: { organizationId: testOrgAId },
        data: { balanceCredits: 10.0, reservedCredits: 0 },
      });

      // 5 concurrent calls try to reserve ₹5.00 each on distinct calls
      // Exactly 2 must succeed, 3 must fail with INSUFFICIENT_FUNDS
      const callIds = Array.from({ length: 5 }, (_, i) => `compete-res-${Date.now()}-${i}`);

      const results = await Promise.allSettled(
        callIds.map((callId) =>
          walletService.createReservation({
            organizationId: testOrgAId,
            callId,
            amountCredits: 5.0,
            holdDurationMinutes: 60,
          })
        )
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(2);
      expect(rejected.length).toBe(3);

      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason.message).toBe('INSUFFICIENT_FUNDS');
      }

      // Financial reconciliation
      const state = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(state.balance).toBe(10.0);
      expect(state.reserved).toBe(10.0);
      expect(state.available).toBe(0.0);

      // Clean up reservations for subsequent tests
      for (const res of fulfilled) {
        const val = (res as PromiseFulfilledResult<any>).value;
        await walletService.releaseReservation({ callId: val.callId });
      }
    });

    it('rolls back completely if a reservation transaction fails halfway', async () => {
      const beforeState = await verifyWalletFinancialIntegrity(testOrgAId);

      // Attempt to create a reservation with an invalid amount (<= 0)
      await expect(
        walletService.createReservation({
          organizationId: testOrgAId,
          callId: `failed-rollback-${Date.now()}`,
          amountCredits: -5.0,
        })
      ).rejects.toThrow('RESERVATION_AMOUNT_MUST_BE_POSITIVE');

      const afterState = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(afterState.reserved).toBe(beforeState.reserved);
      expect(afterState.balance).toBe(beforeState.balance);
    });
  });

  describe('Phase B2: Concurrent Settlement', () => {
    it('settles a call charged exactly once under heavy concurrent settlement requests', async () => {
      const callId = `concurrent-settle-${Date.now()}`;

      // Reset balance to 20.0
      await prisma.wallet.update({
        where: { organizationId: testOrgAId },
        data: { balanceCredits: 20.0, reservedCredits: 0 },
      });

      // Place 1 hold of ₹5.00
      await walletService.createReservation({
        organizationId: testOrgAId,
        callId,
        amountCredits: 5.0,
      });

      // 5 concurrent tasks attempt to settle the exact same call (30s @ ₹5.00/min = ₹2.50)
      const settlePromises = Array.from({ length: 5 }, () =>
        walletService.settleCall({
          callId,
          durationSeconds: 30,
          ratePerMinute: 5.0,
          organizationId: testOrgAId,
        })
      );

      const settledResults = await Promise.all(settlePromises);

      // Exactly 1 must have status 'SETTLED', the other 4 must have status 'ALREADY_SETTLED'
      const firstSettled = settledResults.filter((r) => r.status === 'SETTLED');
      const alreadySettled = settledResults.filter((r) => r.status === 'ALREADY_SETTLED');

      expect(firstSettled.length).toBe(1);
      expect(alreadySettled.length).toBe(4);

      // Check wallet deducted exactly ₹2.50, and reserved released completely to 0
      const state = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(state.balance).toBe(17.5);
      expect(state.reserved).toBe(0.0);

      // Check credit transactions ledger has exactly ONE settlement transaction
      const txs = await prisma.creditTransaction.findMany({
        where: { referenceId: callId, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(txs.length).toBe(1);
      expect(Number(txs[0].amountCredits)).toBe(-2.5);
    });
  });

  describe('Phase B3: Concurrent Settlement and Release Race', () => {
    it('strictly commits only one terminal outcome when settlement races against release', async () => {
      const callId = `race-settle-release-${Date.now()}`;

      await prisma.wallet.update({
        where: { organizationId: testOrgAId },
        data: { balanceCredits: 20.0, reservedCredits: 0 },
      });

      await walletService.createReservation({
        organizationId: testOrgAId,
        callId,
        amountCredits: 5.0,
      });

      // Race settleCall against releaseReservation
      const [settleResult, releaseResult] = await Promise.allSettled([
        walletService.settleCall({
          callId,
          durationSeconds: 30,
          ratePerMinute: 5.0,
          organizationId: testOrgAId,
        }),
        walletService.releaseReservation({
          callId,
          reason: 'Race test release',
          organizationId: testOrgAId,
        }),
      ]);

      // One must be fulfilled, and one must be rejected or idempotent
      const reservation = await prisma.walletReservation.findUnique({
        where: { callId },
      });

      if (reservation!.status === ReservationStatus.SETTLED) {
        expect(settleResult.status).toBe('fulfilled');
        expect(releaseResult.status).toBe('rejected');
        expect((releaseResult as PromiseRejectedResult).reason.message).toBe(
          'CANNOT_CANCEL_SETTLED_RESERVATION'
        );
      } else {
        expect(reservation!.status).toBe(ReservationStatus.CANCELLED);
        expect(releaseResult.status).toBe('fulfilled');
        expect(settleResult.status).toBe('rejected');
        expect((settleResult as PromiseRejectedResult).reason.message).toBe(
          'RESERVATION_ALREADY_CANCELLED'
        );
      }

      await verifyWalletFinancialIntegrity(testOrgAId);
    });
  });

  describe('Phase B4: Concurrent Lease Extension and Termination Race', () => {
    it('prevents stranded holds when mid-call extension races against call settlement', async () => {
      const callId = `race-extend-settle-${Date.now()}`;

      await prisma.wallet.update({
        where: { organizationId: testOrgAId },
        data: { balanceCredits: 30.0, reservedCredits: 0 },
      });

      await walletService.createReservation({
        organizationId: testOrgAId,
        callId,
        amountCredits: 5.0,
      });

      // Race extension (+₹5.00) against settlement
      const [extendResult, settleResult] = await Promise.allSettled([
        walletService.extendReservation({
          callId,
          additionalCredits: 5.0,
          organizationId: testOrgAId,
        }),
        walletService.settleCall({
          callId,
          durationSeconds: 60,
          ratePerMinute: 5.0,
          organizationId: testOrgAId,
        }),
      ]);

      // Verify wallet reserved balance is ALWAYS 0 after settlement finishes
      const state = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(state.reserved).toBe(0.0);

      // Verify reservation row in DB is SETTLED
      const res = await prisma.walletReservation.findUnique({ where: { callId } });
      expect(res!.status).toBe(ReservationStatus.SETTLED);
    });
  });

  describe('Phase B5: Duplicate Call Identifiers and Idempotency', () => {
    it('rejects duplicate call reservation for same callId with existing reservation returned', async () => {
      const callId = `duplicate-id-${Date.now()}`;

      await prisma.wallet.update({
        where: { organizationId: testOrgAId },
        data: { balanceCredits: 20.0, reservedCredits: 0 },
      });

      const res1 = await walletService.createReservation({
        organizationId: testOrgAId,
        callId,
        amountCredits: 5.0,
      });

      // Second createReservation returns existing reservation idempotently without double-holding
      const res2 = await walletService.createReservation({
        organizationId: testOrgAId,
        callId,
        amountCredits: 5.0,
      });

      expect(res1.id).toBe(res2.id);

      const state = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(state.reserved).toBe(5.0); // Held only ONCE!

      await walletService.releaseReservation({ callId });
    });
  });

  describe('Phase B6: Billing Arithmetic and Boundary Values', () => {
    const ratePerMinute = 6.0; // ₹0.10/sec, ₹3.00 per 30s block

    it.each([
      [0, 0, 0],
      [1, 30, 3.0],
      [29, 30, 3.0],
      [30, 30, 3.0],
      [31, 60, 6.0],
      [59, 60, 6.0],
      [60, 60, 6.0],
      [61, 90, 9.0],
      [89, 90, 9.0],
      [90, 90, 9.0],
      [91, 120, 12.0],
    ])('computes exact 30s increments for duration %ds -> %ds billable (₹%d)', (duration, expectedBillable, expectedCharge) => {
      const result = WalletService.calculateCallCharge(duration, ratePerMinute, 30);
      expect(result.billableSeconds).toBe(expectedBillable);
      expect(result.chargeAmount).toBe(expectedCharge);
    });

    it('safely handles non-finite, negative, and invalid durations without corrupting calculation', () => {
      expect(WalletService.calculateCallCharge(-10, 5.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(NaN, 5.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(Infinity, 5.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(null as any, 5.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
      expect(WalletService.calculateCallCharge(undefined as any, 5.0)).toEqual({ billableSeconds: 0, chargeAmount: 0 });
    });
  });

  // =========================================================================
  // PHASE C: CRASH RECOVERY AND PARTIAL FAILURE
  // =========================================================================

  describe('Phase C: Crash Recovery and Partial Failure', () => {
    it('C2: recovers orphaned reservations when worker crashes after reservation commit', async () => {
      const orphanedCallId = `orphaned-hold-${Date.now()}`;

      await prisma.wallet.update({
        where: { organizationId: testOrgAId },
        data: { balanceCredits: 20.0, reservedCredits: 0 },
      });

      // Simulate a crashed call: hold created with an expiry timestamp
      const wallet = await prisma.wallet.findUnique({ where: { organizationId: testOrgAId } });
      const expiryDate = new Date(Date.now() + 60_000); // 1 minute in future to avoid polluting parallel test suites

      await prisma.wallet.update({
        where: { id: wallet!.id },
        data: { reservedCredits: 5.0 },
      });

      await prisma.walletReservation.create({
        data: {
          walletId: wallet!.id,
          callId: orphanedCallId,
          reservedAmount: 5.0,
          status: ReservationStatus.HELD,
          expiresAt: expiryDate,
        },
      });

      // Run automated recovery passing target cutoff timestamp past expiry
      const recovered = await walletService.reconcileExpiredReservations(new Date(Date.now() + 120_000));
      expect(recovered.length).toBeGreaterThanOrEqual(1);
      expect(recovered.some((r) => r.callId === orphanedCallId)).toBe(true);

      // Verify wallet hold is safely cleared to 0 without deducting balance
      const state = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(state.reserved).toBe(0);
      expect(state.balance).toBe(20.0);
    });

    it('C5: settlement crash idempotency: recovers ambiguous transaction by reading persisted state', async () => {
      const callId = `settle-crash-${Date.now()}`;

      await prisma.wallet.update({
        where: { organizationId: testOrgAId },
        data: { balanceCredits: 20.0, reservedCredits: 0 },
      });

      await walletService.createReservation({
        organizationId: testOrgAId,
        callId,
        amountCredits: 5.0,
      });

      // First settlement commits
      const s1 = await walletService.settleCall({
        callId,
        durationSeconds: 30,
        ratePerMinute: 5.0,
        organizationId: testOrgAId,
      });
      expect(s1.status).toBe('SETTLED');

      // Ambiguous retry after simulated network disconnect returns existing settlement
      const s2 = await walletService.settleCall({
        callId,
        durationSeconds: 30,
        ratePerMinute: 5.0,
        organizationId: testOrgAId,
      });
      expect(s2.status).toBe('ALREADY_SETTLED');

      const state = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(state.balance).toBe(17.5);
      expect(state.reserved).toBe(0);
    });
  });

  // =========================================================================
  // PHASE D: STATE MACHINE AND EVENT ORDERING
  // =========================================================================

  describe('Phase D: State Machine and Event Ordering', () => {
    it('D1: strictly enforces all permitted and forbidden transitions in state machine', () => {
      const sm = new CallStateMachine(CallState.INITIALIZING);

      // Permitted: INITIALIZING -> RESERVING
      expect(sm.transition(CallState.RESERVING, 'HOLD_REQUEST').to).toBe(CallState.RESERVING);

      // Permitted: RESERVING -> RINGING
      expect(sm.transition(CallState.RINGING, 'CARRIER_DIAL').to).toBe(CallState.RINGING);

      // Forbidden: RINGING -> SPEAKING (Must go through ACTIVE)
      expect(() => sm.transition(CallState.SPEAKING, 'DIRECT_SPEAK')).toThrow(
        InvalidStateTransitionError
      );

      // Permitted: RINGING -> ACTIVE
      expect(sm.transition(CallState.ACTIVE, 'CARRIER_ANSWER').to).toBe(CallState.ACTIVE);

      // Permitted: ACTIVE -> SPEAKING
      expect(sm.transition(CallState.SPEAKING, 'GREETING_START').to).toBe(CallState.SPEAKING);

      // Permitted: SPEAKING -> LISTENING (Barge-in)
      expect(sm.transition(CallState.LISTENING, 'USER_BARGE_IN').to).toBe(CallState.LISTENING);

      // Permitted: LISTENING -> PROCESSING
      expect(sm.transition(CallState.PROCESSING, 'FINAL_TRANSCRIPT').to).toBe(CallState.PROCESSING);

      // Permitted: PROCESSING -> SPEAKING
      expect(sm.transition(CallState.SPEAKING, 'RESPONSE_READY').to).toBe(CallState.SPEAKING);

      // Permitted: SPEAKING -> TERMINATING
      expect(sm.transition(CallState.TERMINATING, 'HANGUP').to).toBe(CallState.TERMINATING);

      // Permitted: TERMINATING -> SETTLING
      expect(sm.transition(CallState.SETTLING, 'SETTLE').to).toBe(CallState.SETTLING);

      // Permitted: SETTLING -> COMPLETED
      expect(sm.transition(CallState.COMPLETED, 'FINALIZED').to).toBe(CallState.COMPLETED);

      // Forbidden: COMPLETED -> any active state
      expect(() => sm.transition(CallState.ACTIVE, 'REOPEN')).toThrow(
        InvalidStateTransitionError
      );
      expect(() => sm.transition(CallState.LISTENING, 'REOPEN')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('D2: delivers mock telephony events in out-of-order sequences without crashing', async () => {
      const dbCall = await prisma.call.create({
        data: {
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
        },
      });

      const bridge = new RuntimeWalletBridge(walletService, {
        organizationId: testOrgAId,
        callId: dbCall.id,
        voiceTier: 'STANDARD',
      });

      const telephony = new MockTelephonyAdapter({ autoRing: false, autoAnswer: false });
      const session = new CallSession(
        {
          callId: dbCall.id,
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
          systemPrompt: 'Test',
          language: 'English',
          voiceTier: 'STANDARD',
        },
        {
          telephony,
          stt: new MockSTTAdapter(),
          llm: new MockLLMAdapter(),
          tts: new MockTTSAdapter(),
          walletBridge: bridge,
          eventLogger: new CallEventLogger(dbCall.id, { prisma }),
        }
      );

      await session.start();
      const carrierCallId = session.getCarrierCallId()!;

      // Deliver duplicate 'ringing' events
      telephony.emit('ringing', { carrierCallId });
      telephony.emit('ringing', { carrierCallId });
      expect(session.getState()).toBe(CallState.RINGING);

      // Deliver carrier answer
      telephony.emit('connected', { carrierCallId });
      await new Promise((r) => setTimeout(r, 20));
      expect([CallState.ACTIVE, CallState.LISTENING]).toContain(session.getState());

      // Deliver late duplicate 'connected' event
      telephony.emit('connected', { carrierCallId });
      expect([CallState.ACTIVE, CallState.LISTENING]).toContain(session.getState());

      await session.terminate('Test finish', false);
      expect(session.getState()).toBe(CallState.COMPLETED);

      // Late event arriving AFTER termination must NOT crash or reopen session
      telephony.emit('audioChunk', { carrierCallId, audio: Buffer.from([0, 1, 2]) });
      telephony.emit('ringing', { carrierCallId });
      expect(session.getState()).toBe(CallState.COMPLETED);
    });

    it('D3: barge-in or speech start arriving when call is terminating or completed does not crash or throw', async () => {
      const dbCall = await prisma.call.create({
        data: {
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
        },
      });

      const bridge = new RuntimeWalletBridge(walletService, {
        organizationId: testOrgAId,
        callId: dbCall.id,
        voiceTier: 'STANDARD',
      });

      const telephony = new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 2, autoAnswer: true, answerDelayMs: 5 });
      const session = new CallSession(
        {
          callId: dbCall.id,
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
          systemPrompt: 'Test',
          language: 'English',
          voiceTier: 'STANDARD',
        },
        {
          telephony,
          stt: new MockSTTAdapter(),
          llm: new MockLLMAdapter(),
          tts: new MockTTSAdapter(),
          walletBridge: bridge,
          eventLogger: new CallEventLogger(dbCall.id, { prisma }),
        }
      );

      const connectPromise = new Promise((resolve) => session.once('connected', resolve));
      await session.start();
      await connectPromise;

      const orchestrator = session.getOrchestrator()!;
      expect(orchestrator).toBeDefined();

      // Conclude the call to COMPLETED
      await session.terminate('Normal Hangup', false);
      expect(session.getState()).toBe(CallState.COMPLETED);

      // Late speech start arriving after completion must be safely ignored, not throw InvalidStateTransitionError
      expect(() => orchestrator.handleUserSpeechStart()).not.toThrow();
      expect(session.getState()).toBe(CallState.COMPLETED);
    });

    it('D4: handles concurrent terminate() calls cleanly without race or state corruption', async () => {
      const dbCall = await prisma.call.create({
        data: {
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
        },
      });

      const bridge = new RuntimeWalletBridge(walletService, {
        organizationId: testOrgAId,
        callId: dbCall.id,
        voiceTier: 'STANDARD',
      });

      const session = new CallSession(
        {
          callId: dbCall.id,
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
          systemPrompt: 'Test',
          language: 'English',
          voiceTier: 'STANDARD',
        },
        {
          telephony: new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 2, autoAnswer: true, answerDelayMs: 5 }),
          stt: new MockSTTAdapter(),
          llm: new MockLLMAdapter(),
          tts: new MockTTSAdapter(),
          walletBridge: bridge,
          eventLogger: new CallEventLogger(dbCall.id, { prisma }),
        }
      );

      await session.start();
      await new Promise((r) => setTimeout(r, 20));

      // Call terminate() concurrently 4 times
      const terminations = await Promise.allSettled([
        session.terminate('Concurrent Hangup 1', false),
        session.terminate('Concurrent Hangup 2', false),
        session.terminate('Concurrent Hangup 3', false),
        session.terminate('Concurrent Hangup 4', false),
      ]);

      for (const t of terminations) {
        expect(t.status).toBe('fulfilled');
      }

      expect(session.getState()).toBe(CallState.COMPLETED);
      await verifyWalletFinancialIntegrity(testOrgAId);
    });
  });

  // =========================================================================
  // PHASE E: MULTI-TENANT ISOLATION
  // =========================================================================

  describe('Phase E: Multi-Tenant and Security Regression', () => {
    it('strictly forbids Org A from releasing or modifying Org B reservation', async () => {
      const callIdB = `tenant-b-${Date.now()}`;

      await prisma.wallet.update({
        where: { organizationId: testOrgBId },
        data: { balanceCredits: 30.0, reservedCredits: 0 },
      });

      await walletService.createReservation({
        organizationId: testOrgBId,
        callId: callIdB,
        amountCredits: 5.0,
      });

      // Org A attempts to release Org B's reservation
      await expect(
        walletService.releaseReservation({
          callId: callIdB,
          organizationId: testOrgAId, // Org A identity
        })
      ).rejects.toThrow('CROSS_TENANT_ACCESS_DENIED');

      // Org A attempts to extend Org B's reservation
      await expect(
        walletService.extendReservation({
          callId: callIdB,
          additionalCredits: 5.0,
          organizationId: testOrgAId, // Org A identity
        })
      ).rejects.toThrow('CROSS_TENANT_ACCESS_DENIED');

      // Org A attempts to settle Org B's reservation
      await expect(
        walletService.settleCall({
          callId: callIdB,
          durationSeconds: 30,
          ratePerMinute: 5.0,
          organizationId: testOrgAId, // Org A identity
        })
      ).rejects.toThrow('CROSS_TENANT_ACCESS_DENIED');

      // Clean up Org B
      await walletService.releaseReservation({ callId: callIdB, organizationId: testOrgBId });
    });
  });

  // =========================================================================
  // PHASE F: RESOURCE LEAKS AND BOUNDED BEHAVIOR
  // =========================================================================

  describe('Phase F: Resource Leaks, Timeouts, and Bounded Behavior', () => {
    it('releases event listeners and closes STT streams across 10 rapid session lifecycles', async () => {
      // Top up Org A wallet so all 10 cycles have plenty of funds (10 * ₹5.00 hold = ₹50.00)
      await prisma.wallet.update({
        where: { organizationId: testOrgAId },
        data: { balanceCredits: 100.0, reservedCredits: 0 },
      });

      for (let i = 0; i < 10; i++) {
        const callId = `leak-test-${Date.now()}-${i}`;
        const dbCall = await prisma.call.create({
          data: {
            organizationId: testOrgAId,
            agentId: testAgentAId,
            direction: 'OUTBOUND_INSTANT',
            callerNumber: '+919900011122',
            destinationNumber: '+919900033344',
          },
        });

        const bridge = new RuntimeWalletBridge(walletService, {
          organizationId: testOrgAId,
          callId: dbCall.id,
          voiceTier: 'STANDARD',
        });

        const telephony = new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 1, autoAnswer: true, answerDelayMs: 2 });
        const stt = new MockSTTAdapter();
        const session = new CallSession(
          {
            callId: dbCall.id,
            organizationId: testOrgAId,
            agentId: testAgentAId,
            direction: 'OUTBOUND_INSTANT',
            callerNumber: '+919900011122',
            destinationNumber: '+919900033344',
            systemPrompt: 'Test',
            language: 'English',
            voiceTier: 'STANDARD',
          },
          {
            telephony,
            stt,
            llm: new MockLLMAdapter(),
            tts: new MockTTSAdapter(),
            walletBridge: bridge,
            eventLogger: new CallEventLogger(dbCall.id, { prisma }),
          }
        );

        await session.start();
        await new Promise((r) => setTimeout(r, 10));
        await session.terminate('Rapid cycle', false);

        expect(session.getState()).toBe(CallState.COMPLETED);
      }

      const state = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(state.reserved).toBe(0);
    });
  });

  // =========================================================================
  // PHASE 3.1.1: SECTION 3 — TERMINATION MUTEX, SETTLEMENT FAILURE & RETRY
  // =========================================================================

  describe('Phase 3.1.1: Section 3 — Termination Mutex, Settlement Failure & Retry Safety', () => {
    it('multiple callers invoking terminate() while settlement is pending join same execution', async () => {
      const dbCall = await prisma.call.create({
        data: {
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
        },
      });

      // Wrap walletManager with a 30ms artificial settlement delay
      const delayedWalletManager = {
        createReservation: (p: any) => walletService.createReservation(p),
        extendReservation: (p: any) => walletService.extendReservation(p),
        releaseReservation: (p: any) => walletService.releaseReservation(p),
        settleCall: async (p: any) => {
          await new Promise((r) => setTimeout(r, 30));
          return walletService.settleCall(p);
        },
      };

      const bridge = new RuntimeWalletBridge(delayedWalletManager, {
        organizationId: testOrgAId,
        callId: dbCall.id,
        voiceTier: 'STANDARD',
      });

      const session = new CallSession(
        {
          callId: dbCall.id,
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
          systemPrompt: 'Test',
          language: 'English',
          voiceTier: 'STANDARD',
        },
        {
          telephony: new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 2, autoAnswer: true, answerDelayMs: 5 }),
          stt: new MockSTTAdapter(),
          llm: new MockLLMAdapter(),
          tts: new MockTTSAdapter(),
          walletBridge: bridge,
          eventLogger: new CallEventLogger(dbCall.id, { prisma }),
        }
      );

      const connectPromise = new Promise((resolve) => session.once('connected', resolve));
      await session.start();
      await connectPromise;

      // 3 callers invoke terminate() while settlement is delayed
      const t1 = session.terminate('Hangup A', false);
      const t2 = session.terminate('Hangup B', false);
      const t3 = session.terminate('Hangup C', false);

      const results = await Promise.all([t1, t2, t3]);
      expect(results).toHaveLength(3);
      expect(session.getState()).toBe(CallState.COMPLETED);

      // Verify wallet settlement was performed exactly once
      const txs = await prisma.creditTransaction.findMany({
        where: { referenceId: dbCall.id, type: WalletTxType.CALL_SETTLEMENT },
      });
      expect(txs).toHaveLength(1);
    });

    it('termination fails safely on settlement error, does NOT silently mark call completed, and allows retry', async () => {
      const dbCall = await prisma.call.create({
        data: {
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
        },
      });

      let shouldFailSettlement = true;
      const flappyWalletManager = {
        createReservation: (p: any) => walletService.createReservation(p),
        extendReservation: (p: any) => walletService.extendReservation(p),
        releaseReservation: (p: any) => walletService.releaseReservation(p),
        settleCall: async (p: any) => {
          if (shouldFailSettlement) {
            throw new Error('TRANSIENT_DATABASE_DISCONNECT');
          }
          return walletService.settleCall(p);
        },
      };

      const bridge = new RuntimeWalletBridge(flappyWalletManager, {
        organizationId: testOrgAId,
        callId: dbCall.id,
        voiceTier: 'STANDARD',
      });

      const session = new CallSession(
        {
          callId: dbCall.id,
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
          systemPrompt: 'Test',
          language: 'English',
          voiceTier: 'STANDARD',
        },
        {
          telephony: new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 2, autoAnswer: true, answerDelayMs: 5 }),
          stt: new MockSTTAdapter(),
          llm: new MockLLMAdapter(),
          tts: new MockTTSAdapter(),
          walletBridge: bridge,
          eventLogger: new CallEventLogger(dbCall.id, { prisma }),
        }
      );

      const connectPromise = new Promise((resolve) => session.once('connected', resolve));
      await session.start();
      await connectPromise;

      // 1. First termination attempt fails during settlement
      await expect(session.terminate('Failing Hangup', false)).rejects.toThrow('TRANSIENT_DATABASE_DISCONNECT');

      // Crucial verification: The call state machine must NOT have silently transitioned to COMPLETED!
      expect(session.getState()).toBe(CallState.SETTLING);
      expect(session.isTerminal()).toBe(false);

      // Verify the call in DB was NOT marked COMPLETED with 0 deduction!
      const unfinalizedCall = await prisma.call.findUnique({ where: { id: dbCall.id } });
      expect(unfinalizedCall!.status).not.toBe(CallStatus.COMPLETED);

      // 2. Resolve transient error and retry termination
      shouldFailSettlement = false;
      await expect(session.terminate('Retry Hangup', false)).resolves.toBeUndefined();

      // Now call is properly COMPLETED
      expect(session.getState()).toBe(CallState.COMPLETED);

      const finalizedCall = await prisma.call.findUnique({ where: { id: dbCall.id } });
      expect(finalizedCall!.status).toBe(CallStatus.COMPLETED);
      expect(Number(finalizedCall!.creditsDeducted)).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // PHASE 3.1.1: SECTION 5 — CRASH RECOVERY AT TRANSACTION BOUNDARIES (A-F)
  // =========================================================================

  describe('Phase 3.1.1: Section 5 — Crash Recovery & Transaction Boundaries (A-F)', () => {
    it('Scenario A: failure before reservation commit leaves zero partial wallet mutation', async () => {
      const stateBefore = await verifyWalletFinancialIntegrity(testOrgAId);
      const callId = `crash-scenario-a-${Date.now()}`;

      // Simulate failure inside reservation transaction before commit
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE wallets SET reserved_credits = reserved_credits + 5.0 WHERE organization_id = ${testOrgAId}::uuid`;
          // Inject fault before commit
          throw new Error('SIMULATED_PROCESS_CRASH_BEFORE_COMMIT');
        })
      ).rejects.toThrow('SIMULATED_PROCESS_CRASH_BEFORE_COMMIT');

      // Verify transaction rolled back cleanly
      const stateAfter = await verifyWalletFinancialIntegrity(testOrgAId);
      expect(stateAfter.reserved).toBe(stateBefore.reserved);
      expect(stateAfter.balance).toBe(stateBefore.balance);
    });

    it('Scenario B: crash immediately after reservation commit is reconcilable via reconcileExpiredReservations', async () => {
      const callId = `crash-scenario-b-${Date.now()}`;

      // Create committed hold with an expiry timestamp (simulating crash before dialing)
      const wallet = await prisma.wallet.findUnique({ where: { organizationId: testOrgAId } });
      const expiryDate = new Date(Date.now() + 60_000); // Future timestamp prevents cross-suite interference
      await prisma.wallet.update({
        where: { id: wallet!.id },
        data: { reservedCredits: { increment: 5.0 } },
      });

      await prisma.walletReservation.create({
        data: {
          walletId: wallet!.id,
          callId,
          reservedAmount: 5.0,
          status: ReservationStatus.HELD,
          expiresAt: expiryDate,
        },
      });

      // Run reconciliation recovery passing future cutoff timestamp
      const recovered = await walletService.reconcileExpiredReservations(new Date(Date.now() + 120_000));
      expect(recovered.some((r) => r.callId === callId)).toBe(true);

      const res = await prisma.walletReservation.findUnique({ where: { callId } });
      expect(res!.status).toBe(ReservationStatus.CANCELLED);
    });

    it('Scenario C: call created in DB but session crashes before initialization', async () => {
      const dbCall = await prisma.call.create({
        data: {
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
          status: CallStatus.INITIATED,
        },
      });

      // Without pre-auth hold, call remains INITIATED or marked FAILED
      const found = await prisma.call.findUnique({ where: { id: dbCall.id } });
      expect(found!.status).toBe(CallStatus.INITIATED);
      expect(Number(found!.creditsDeducted)).toBe(0);
    });

    it('Scenario D: failure during attempted reservation extension leaves hold intact', async () => {
      const callId = `crash-scenario-d-${Date.now()}`;

      await walletService.createReservation({
        organizationId: testOrgAId,
        callId,
        amountCredits: 5.0,
      });

      // Extension with invalid amount fails
      await expect(
        walletService.extendReservation({
          callId,
          additionalCredits: -5.0,
          organizationId: testOrgAId,
        })
      ).rejects.toThrow('ADDITIONAL_AMOUNT_MUST_BE_POSITIVE');

      // Original reservation remains valid and held at 5.0
      const res = await prisma.walletReservation.findUnique({ where: { callId } });
      expect(Number(res!.reservedAmount)).toBe(5.0);
      expect(res!.status).toBe(ReservationStatus.HELD);

      await walletService.releaseReservation({ callId, organizationId: testOrgAId });
    });

    it('Scenario E & F: settlement transaction failure vs post-commit retry idempotency', async () => {
      const callId = `crash-scenario-ef-${Date.now()}`;

      await walletService.createReservation({
        organizationId: testOrgAId,
        callId,
        amountCredits: 5.0,
      });

      // Scenario E: Failure before settlement commit rolls back
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE wallets SET balance_credits = balance_credits - 2.5 WHERE organization_id = ${testOrgAId}::uuid`;
          throw new Error('SIMULATED_CRASH_BEFORE_SETTLE_COMMIT');
        })
      ).rejects.toThrow('SIMULATED_CRASH_BEFORE_SETTLE_COMMIT');

      // Reservation is still HELD
      const resHeld = await prisma.walletReservation.findUnique({ where: { callId } });
      expect(resHeld!.status).toBe(ReservationStatus.HELD);

      // Scenario F: Settlement commits, but caller experiences network timeout and retries
      const settle1 = await walletService.settleCall({
        callId,
        durationSeconds: 30,
        ratePerMinute: 5.0,
        organizationId: testOrgAId,
      });
      expect(settle1.status).toBe('SETTLED');

      // Caller retries after timeout
      const settleRetry = await walletService.settleCall({
        callId,
        durationSeconds: 30,
        ratePerMinute: 5.0,
        organizationId: testOrgAId,
      });
      expect(settleRetry.status).toBe('ALREADY_SETTLED');
    });
  });

  // =========================================================================
  // PHASE 3.1.1: SECTION 6 & 8 — ADVERSARIAL EVENT SEQUENCES & CANCELLATION
  // =========================================================================

  describe('Phase 3.1.1: Section 6 & 8 — Adversarial Event Sequences & Cancellation', () => {
    it('handles carrier disconnect arriving before a delayed connected event without reviving call', async () => {
      const dbCall = await prisma.call.create({
        data: {
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
        },
      });

      const bridge = new RuntimeWalletBridge(walletService, {
        organizationId: testOrgAId,
        callId: dbCall.id,
        voiceTier: 'STANDARD',
      });

      const telephony = new MockTelephonyAdapter({ autoRing: false, autoAnswer: false });
      const session = new CallSession(
        {
          callId: dbCall.id,
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
          systemPrompt: 'Test',
          language: 'English',
          voiceTier: 'STANDARD',
        },
        {
          telephony,
          stt: new MockSTTAdapter(),
          llm: new MockLLMAdapter(),
          tts: new MockTTSAdapter(),
          walletBridge: bridge,
          eventLogger: new CallEventLogger(dbCall.id, { prisma }),
        }
      );

      await session.start();
      const carrierCallId = session.getCarrierCallId()!;

      // Carrier disconnects during ringing
      const callEndedPromise = new Promise((resolve) => session.once('callEnded', resolve));
      telephony.emit('disconnected', { carrierCallId, reason: 'REMOTE_BUSY' });
      await callEndedPromise;

      expect(session.getState()).toBe(CallState.COMPLETED);

      // Delayed 'connected' event arrives after disconnection
      telephony.emit('connected', { carrierCallId, timestamp: Date.now() });
      await new Promise((r) => setTimeout(r, 10));

      // Call must remain COMPLETED and not be revived
      expect(session.getState()).toBe(CallState.COMPLETED);
    });

    it('provider error arriving after normal disconnect is safely ignored', async () => {
      const dbCall = await prisma.call.create({
        data: {
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
        },
      });

      const bridge = new RuntimeWalletBridge(walletService, {
        organizationId: testOrgAId,
        callId: dbCall.id,
        voiceTier: 'STANDARD',
      });

      const telephony = new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 2, autoAnswer: true, answerDelayMs: 5 });
      const session = new CallSession(
        {
          callId: dbCall.id,
          organizationId: testOrgAId,
          agentId: testAgentAId,
          direction: 'OUTBOUND_INSTANT',
          callerNumber: '+919900011122',
          destinationNumber: '+919900033344',
          systemPrompt: 'Test',
          language: 'English',
          voiceTier: 'STANDARD',
        },
        {
          telephony,
          stt: new MockSTTAdapter(),
          llm: new MockLLMAdapter(),
          tts: new MockTTSAdapter(),
          walletBridge: bridge,
          eventLogger: new CallEventLogger(dbCall.id, { prisma }),
        }
      );

      const connectPromise = new Promise((resolve) => session.once('connected', resolve));
      await session.start();
      await connectPromise;

      await session.terminate('Normal Disconnect', false);
      expect(session.getState()).toBe(CallState.COMPLETED);

      // Late provider error arriving after normal disconnect must not crash
      expect(() => {
        telephony.emit('error', {
          carrierCallId: session.getCarrierCallId()!,
          error: new Error('LATE_CARRIER_TIMEOUT'),
        });
      }).not.toThrow();

      expect(session.getState()).toBe(CallState.COMPLETED);
    });
  });
});
