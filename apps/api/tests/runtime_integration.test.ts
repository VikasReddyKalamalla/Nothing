import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Role, AgentRoleType, VoiceTier, CallStatus, SpeakerType } from '@auris/database';
import { WalletService } from '../src/modules/wallets/wallet.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import {
  CallSession,
  CallState,
  MockTelephonyAdapter,
  MockSTTAdapter,
  MockLLMAdapter,
  MockTTSAdapter,
  RuntimeWalletBridge,
  CallEventLogger,
  InsufficientFundsError,
} from '@auris/runtime';

describe('Auris Voice Runtime - End-to-End Database & Financial Integration Tests', () => {
  let prisma: PrismaClient;
  let walletService: WalletService;

  let orgAId: string;
  let agentAId: string;
  let orgBId: string;
  let agentBId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    walletService = new WalletService(prisma);

    // Provision Org A with Agent
    const regA = await AuthService.registerUser({
      email: `runtime-org-a-${Date.now()}@auris.local`,
      password: 'password123',
      name: 'Runtime Admin A',
      organizationName: `Runtime Org A ${Date.now()}`,
    });
    orgAId = regA.org.id;

    const agentA = await prisma.agent.create({
      data: {
        organizationId: orgAId,
        name: 'Dr. Reddy Clinic Assistant',
        roleType: AgentRoleType.INSTANT_LEAD,
        voiceTier: VoiceTier.STANDARD,
        primaryLanguage: 'English',
        promptTemplate: 'You are an appointment coordinator for Dr. Reddy Clinic.',
        isActive: true,
      },
    });
    agentAId = agentA.id;

    // Provision Org B with Agent (for tenant isolation tests)
    const regB = await AuthService.registerUser({
      email: `runtime-org-b-${Date.now()}@auris.local`,
      password: 'password123',
      name: 'Runtime Admin B',
      organizationName: `Runtime Org B ${Date.now()}`,
    });
    orgBId = regB.org.id;

    const agentB = await prisma.agent.create({
      data: {
        organizationId: orgBId,
        name: 'Apex Academy Counselor',
        roleType: AgentRoleType.INSTANT_LEAD,
        voiceTier: VoiceTier.STANDARD,
        primaryLanguage: 'English',
        promptTemplate: 'You are an educational counselor.',
        isActive: true,
      },
    });
    agentBId = agentB.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('executes full outbound call lifecycle: pre-auth hold, turn loop, DB transcripts, events, and 30s unit settlement', async () => {
    // 1. Create Call record in DB
    const dbCall = await prisma.call.create({
      data: {
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        status: CallStatus.INITIATED,
      },
    });

    const bridge = new RuntimeWalletBridge(walletService, {
      organizationId: orgAId,
      callId: dbCall.id,
      voiceTier: 'STANDARD', // ₹5.00/min
      billingBlockSeconds: 30,
    });

    const telephony = new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 5, autoAnswer: true, answerDelayMs: 10 });
    const stt = new MockSTTAdapter();
    const llm = new MockLLMAdapter({ timeToFirstTokenMs: 10, tokenIntervalMs: 5 });
    llm.setResponseForPattern('appointment', 'Dr. Reddy clinic has an open consultation slot at 4:30 PM this Saturday.');
    const tts = new MockTTSAdapter({ firstChunkDelayMs: 10, chunkIntervalMs: 5 });
    const eventLogger = new CallEventLogger(dbCall.id, { prisma });

    const session = new CallSession(
      {
        callId: dbCall.id,
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'You are an appointment assistant.',
        language: 'English',
        voiceTier: 'STANDARD',
      },
      {
        telephony,
        stt,
        llm,
        tts,
        walletBridge: bridge,
        eventLogger,
      }
    );

    // Initial wallet balance before call
    const initialWallet = await prisma.wallet.findUnique({ where: { organizationId: orgAId } });
    const initialBalance = Number(initialWallet!.balanceCredits);

    // 2. Start session (Pre-auth hold acquired & carrier dialed)
    await session.start();

    // Verify pre-auth hold in DB
    const holdRes = await prisma.walletReservation.findUnique({ where: { callId: dbCall.id } });
    expect(holdRes).toBeDefined();
    expect(Number(holdRes!.reservedAmount)).toBe(5.00);

    // Wait for carrier answer deterministically
    if (!session.getSTTStream()) {
      await new Promise((resolve) => session.once('connected', resolve));
    }
    expect([CallState.ACTIVE, CallState.SPEAKING, CallState.LISTENING]).toContain(session.getState());

    // 3. Simulate user conversation turn
    const sttStream = session.getSTTStream() as any;
    expect(sttStream).toBeDefined();

    const turnCompletePromise = new Promise((resolve) => session.once('turnComplete', resolve));

    await sttStream.simulateSpeech('I would like to book an appointment for my consultation.', {
      speechStartDelayMs: 5,
      partialIntervalMs: 5,
      finalLatencyMs: 10,
    });

    // Wait for LLM and TTS turn completion and DB write
    await turnCompletePromise;
    await new Promise((r) => setTimeout(r, 20));

    // 4. Conclude call
    await session.terminate('Normal Hangup', false);
    expect(session.getState()).toBe(CallState.COMPLETED);

    // 5. Verify Database Records
    // A. Call record finalized
    const updatedCall = await prisma.call.findUnique({ where: { id: dbCall.id } });
    expect(updatedCall!.status).toBe(CallStatus.COMPLETED);
    expect(updatedCall!.billableSeconds).toBe(30); // 1 block of 30s
    expect(Number(updatedCall!.creditsDeducted)).toBe(2.50); // (30 / 60) * ₹5.00 = ₹2.50
    expect(updatedCall!.terminationReason).toBe('Normal Hangup');

    // B. Transcripts persisted in DB
    const transcripts = await prisma.transcript.findMany({ where: { callId: dbCall.id } });
    expect(transcripts.length).toBeGreaterThanOrEqual(2);
    expect(transcripts.some((t) => t.speaker === SpeakerType.CALLER && t.text.includes('appointment'))).toBe(true);
    expect(transcripts.some((t) => t.speaker === SpeakerType.AGENT && t.text.includes('4:30 PM'))).toBe(true);

    // C. Call events logged in DB
    const events = await prisma.callEvent.findMany({ where: { callId: dbCall.id } });
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.some((e) => e.eventType === 'PREAUTH_HOLD_ACQUIRED')).toBe(true);
    expect(events.some((e) => e.eventType === 'CALL_CONNECTED')).toBe(true);
    expect(events.some((e) => e.eventType === 'SETTLEMENT_COMPLETED')).toBe(true);

    // D. Wallet balance reduced atomically without hold leakage
    const finalWallet = await prisma.wallet.findUnique({ where: { organizationId: orgAId } });
    expect(Number(finalWallet!.reservedCredits)).toBe(0); // Hold completely settled
    expect(Number(finalWallet!.balanceCredits)).toBe(Number((initialBalance - 2.50).toFixed(4)));
  });

  it('handles speech interruption (barge-in): stops agent TTS, clears buffer, and switches to listening', async () => {
    const dbCall = await prisma.call.create({
      data: {
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
      },
    });

    const bridge = new RuntimeWalletBridge(walletService, {
      organizationId: orgAId,
      callId: dbCall.id,
      voiceTier: 'STANDARD',
    });

    const telephony = new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 2, autoAnswer: true, answerDelayMs: 5 });
    const stt = new MockSTTAdapter();
    const llm = new MockLLMAdapter({ timeToFirstTokenMs: 5, tokenIntervalMs: 5 });
    llm.defaultResponse = 'This is a very long agent speech explaining directions to Kondapur clinic in detail.';
    const tts = new MockTTSAdapter({ firstChunkDelayMs: 5, chunkIntervalMs: 15 });
    const eventLogger = new CallEventLogger(dbCall.id, { prisma });

    const session = new CallSession(
      {
        callId: dbCall.id,
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'Detailed directions assistant.',
        language: 'English',
        voiceTier: 'STANDARD',
      },
      {
        telephony,
        stt,
        llm,
        tts,
        walletBridge: bridge,
        eventLogger,
      }
    );

    session.setInitialGreeting('This is a very long agent speech explaining directions in detail.');
    await session.start();

    // Wait for connection and greeting to begin playing deterministically
    if (!session.getOrchestrator()) {
      await new Promise((resolve) => session.once('connected', resolve));
    }
    await new Promise((r) => setTimeout(r, 10));

    let bargeInDetected = false;
    session.on('bargeIn', () => {
      bargeInDetected = true;
    });

    // Caller interrupts mid-greeting!
    const orchestrator = session.getOrchestrator()!;
    orchestrator.handleUserSpeechStart();

    expect(bargeInDetected).toBe(true);
    expect(session.getState()).toBe(CallState.LISTENING);
    expect(telephony.clearedBuffersCount.get(session.getCarrierCallId()!)).toBe(1);

    await session.terminate('Interrupted Normal Hangup', false);
    expect(session.getState()).toBe(CallState.COMPLETED);
  });

  it('releases reservation hold with zero charge when call is not answered or rejected', async () => {
    const dbCall = await prisma.call.create({
      data: {
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
      },
    });

    const bridge = new RuntimeWalletBridge(walletService, {
      organizationId: orgAId,
      callId: dbCall.id,
      voiceTier: 'STANDARD',
    });

    const initialWallet = await prisma.wallet.findUnique({ where: { organizationId: orgAId } });
    const initialBalance = Number(initialWallet!.balanceCredits);

    const telephony = new MockTelephonyAdapter({ autoRing: true, autoAnswer: false });
    const session = new CallSession(
      {
        callId: dbCall.id,
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'Assistant',
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

    // Verify hold was placed for this call
    const midHold = await prisma.walletReservation.findUnique({ where: { callId: dbCall.id } });
    expect(midHold).toBeDefined();
    expect(Number(midHold!.reservedAmount)).toBe(5.00);

    // Call times out / no answer
    await session.terminate('NO_ANSWER', false);

    // Verify hold was completely released with 0 deduction
    const finalWallet = await prisma.wallet.findUnique({ where: { organizationId: orgAId } });
    expect(Number(finalWallet!.reservedCredits)).toBe(0);
    expect(Number(finalWallet!.balanceCredits)).toBe(initialBalance); // Completely unchanged!

    const callRecord = await prisma.call.findUnique({ where: { id: dbCall.id } });
    expect(Number(callRecord!.creditsDeducted)).toBe(0);
    expect(callRecord!.outcome).toBe('NO_ANSWER');
  });

  it('strictly blocks call initiation when organization has insufficient wallet funds', async () => {
    // Deplete Org B's wallet to 0 for test
    await prisma.wallet.update({
      where: { organizationId: orgBId },
      data: { balanceCredits: 0, reservedCredits: 0 },
    });

    const dbCall = await prisma.call.create({
      data: {
        organizationId: orgBId,
        agentId: agentBId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
      },
    });

    const bridge = new RuntimeWalletBridge(walletService, {
      organizationId: orgBId,
      callId: dbCall.id,
      voiceTier: 'STANDARD',
    });

    const session = new CallSession(
      {
        callId: dbCall.id,
        organizationId: orgBId,
        agentId: agentBId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'Assistant',
        language: 'English',
        voiceTier: 'STANDARD',
      },
      {
        telephony: new MockTelephonyAdapter(),
        stt: new MockSTTAdapter(),
        llm: new MockLLMAdapter(),
        tts: new MockTTSAdapter(),
        walletBridge: bridge,
        eventLogger: new CallEventLogger(dbCall.id, { prisma }),
      }
    );

    await expect(session.start()).rejects.toThrow(InsufficientFundsError);

    // Verify Call is FAILED and wallet was not touched
    const callRecord = await prisma.call.findUnique({ where: { id: dbCall.id } });
    expect(callRecord!.status).toBe(CallStatus.FAILED);
    expect(callRecord!.terminationReason).toBe('INSUFFICIENT_FUNDS');
    expect(Number(callRecord!.creditsDeducted)).toBe(0);
  });

  it('guarantees tenant isolation: Org A cannot settle or release Org B call reservation', async () => {
    // Restore Org B balance
    await prisma.wallet.update({
      where: { organizationId: orgBId },
      data: { balanceCredits: 50.0, reservedCredits: 0 },
    });

    const dbCallB = await prisma.call.create({
      data: {
        organizationId: orgBId,
        agentId: agentBId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
      },
    });

    // Create reservation under Org B
    await walletService.createReservation({
      organizationId: orgBId,
      callId: dbCallB.id,
      amountCredits: 5.0,
    });

    // Org A attempts to settle Org B's call
    await expect(
      walletService.settleCall({
        callId: dbCallB.id,
        durationSeconds: 30,
        ratePerMinute: 5.0,
        organizationId: orgAId, // Cross-tenant Org A!
      })
    ).rejects.toThrow('CROSS_TENANT_ACCESS_DENIED');

    // Org A attempts to extend Org B's call
    await expect(
      walletService.extendReservation({
        callId: dbCallB.id,
        additionalCredits: 5.0,
        organizationId: orgAId, // Cross-tenant Org A!
      })
    ).rejects.toThrow('CROSS_TENANT_ACCESS_DENIED');

    // Clean up reservation
    await walletService.releaseReservation({ callId: dbCallB.id });
  });

  it('guarantees idempotent termination: duplicate terminate calls do not double-charge or corrupt state', async () => {
    const dbCall = await prisma.call.create({
      data: {
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
      },
    });

    const bridge = new RuntimeWalletBridge(walletService, {
      organizationId: orgAId,
      callId: dbCall.id,
      voiceTier: 'STANDARD',
    });

    const session = new CallSession(
      {
        callId: dbCall.id,
        organizationId: orgAId,
        agentId: agentAId,
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'Assistant',
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
    await new Promise((r) => setTimeout(r, 30));

    // First termination
    await session.terminate('First Hangup', false);
    expect(session.getState()).toBe(CallState.COMPLETED);

    const callAfterFirst = await prisma.call.findUnique({ where: { id: dbCall.id } });
    const deductedFirst = Number(callAfterFirst!.creditsDeducted);

    // Second termination (simulating duplicate webhook / race condition)
    await session.terminate('Duplicate Webhook', false);
    expect(session.getState()).toBe(CallState.COMPLETED);

    // Verify credits deducted did not double
    const callAfterSecond = await prisma.call.findUnique({ where: { id: dbCall.id } });
    expect(Number(callAfterSecond!.creditsDeducted)).toBe(deductedFirst);
  });
});
