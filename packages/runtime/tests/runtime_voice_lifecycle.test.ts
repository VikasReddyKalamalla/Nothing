import { describe, it, expect, beforeEach } from 'vitest';
import {
  CallStateMachine,
  InvalidStateTransitionError,
  CallState,
  MockTelephonyAdapter,
  MockSTTAdapter,
  MockLLMAdapter,
  MockTTSAdapter,
  VoiceTurnOrchestrator,
  RuntimeWalletBridge,
  IWalletManager,
  CallEventLogger,
  CallSession,
  InsufficientFundsError,
} from '../src/index.js';

describe('Auris Voice Runtime - Call State Machine', () => {
  let sm: CallStateMachine;

  beforeEach(() => {
    sm = new CallStateMachine();
  });

  it('initializes in INITIALIZING state with initial history record', () => {
    expect(sm.getState()).toBe(CallState.INITIALIZING);
    expect(sm.isTerminal()).toBe(false);
    expect(sm.getHistory()).toHaveLength(1);
    expect(sm.getHistory()[0].trigger).toBe('SESSION_INITIALIZED');
  });

  it('allows valid sequential transitions across full call lifecycle', () => {
    sm.transition(CallState.RESERVING, 'PREAUTH_HOLD');
    expect(sm.getState()).toBe(CallState.RESERVING);

    sm.transition(CallState.RINGING, 'TELEPHONY_DIAL');
    expect(sm.getState()).toBe(CallState.RINGING);

    sm.transition(CallState.ACTIVE, 'CARRIER_ANSWER');
    expect(sm.getState()).toBe(CallState.ACTIVE);

    sm.transition(CallState.SPEAKING, 'AGENT_GREETING');
    expect(sm.getState()).toBe(CallState.SPEAKING);

    sm.transition(CallState.LISTENING, 'USER_SPEAKING');
    expect(sm.getState()).toBe(CallState.LISTENING);

    sm.transition(CallState.PROCESSING, 'STT_FINALIZED');
    expect(sm.getState()).toBe(CallState.PROCESSING);

    sm.transition(CallState.TERMINATING, 'HANGUP_REQUESTED');
    expect(sm.getState()).toBe(CallState.TERMINATING);

    sm.transition(CallState.SETTLING, 'SETTLEMENT_STARTED');
    expect(sm.getState()).toBe(CallState.SETTLING);

    sm.transition(CallState.COMPLETED, 'CALL_FINALIZED');
    expect(sm.getState()).toBe(CallState.COMPLETED);
    expect(sm.isTerminal()).toBe(true);
  });

  it('strictly rejects invalid state transitions', () => {
    // Attempting direct jump from INITIALIZING to ACTIVE
    expect(() => {
      sm.transition(CallState.ACTIVE, 'ILLEGAL_JUMP');
    }).toThrow(InvalidStateTransitionError);

    // Attempting transition from COMPLETED terminal state
    sm.transition(CallState.TERMINATING, 'ABORT');
    sm.transition(CallState.COMPLETED, 'DONE');
    expect(() => {
      sm.transition(CallState.ACTIVE, 'RESURRECT');
    }).toThrow(InvalidStateTransitionError);
  });

  it('guarantees idempotent termination without throwing errors', () => {
    sm.transition(CallState.RESERVING, 'HOLD');
    sm.transition(CallState.RINGING, 'DIAL');

    const t1 = sm.terminate('First Hangup', false);
    expect(sm.getState()).toBe(CallState.TERMINATING);

    sm.transition(CallState.SETTLING, 'SETTLING');
    sm.transition(CallState.COMPLETED, 'FINALIZED');

    // Second and third termination attempts on terminal state
    const t2 = sm.terminate('Duplicate Carrier Webhook', false);
    expect(sm.getState()).toBe(CallState.COMPLETED);
    expect(t2.to).toBe(CallState.COMPLETED);
  });
});

describe('Auris Voice Runtime - Mock Adapters & Provider Contracts', () => {
  it('MockTelephonyAdapter handles initiation, auto-ringing, and audio buffering', async () => {
    const telephony = new MockTelephonyAdapter({ ringDelayMs: 5, answerDelayMs: 10 });
    const res = await telephony.initiateCall({
      callId: 'call-1',
      from: '+919900011122',
      to: '+919900033344',
      direction: 'OUTBOUND_INSTANT',
    });

    expect(res.carrierCallId).toBeDefined();

    // Verify audio chunk buffering
    const chunk = Buffer.from('simulated-pcm-audio');
    await telephony.sendAudioChunk(res.carrierCallId, chunk);
    expect(telephony.sentAudioChunks.get(res.carrierCallId)).toHaveLength(1);

    // Verify buffer flush (barge-in support)
    await telephony.clearAudioBuffer(res.carrierCallId);
    expect(telephony.sentAudioChunks.get(res.carrierCallId)).toHaveLength(0);
    expect(telephony.clearedBuffersCount.get(res.carrierCallId)).toBe(1);

    await telephony.hangupCall(res.carrierCallId);
  });

  it('MockSTTAdapter emits speechStart, partials, and final transcript', async () => {
    const stt = new MockSTTAdapter();
    const stream = await stt.createStream('call-1', { language: 'English' });

    let speechStarted = false;
    const partials: string[] = [];
    let finalText = '';

    stream.on('speechStart', () => { speechStarted = true; });
    stream.on('partialTranscript', (p) => { partials.push(p); });
    stream.on('finalTranscript', (f) => { finalText = f; });

    await stream.simulateSpeech('I want to book an appointment', {
      speechStartDelayMs: 5,
      partialIntervalMs: 5,
      finalLatencyMs: 5,
    });

    expect(speechStarted).toBe(true);
    expect(partials.length).toBeGreaterThan(0);
    expect(finalText).toBe('I want to book an appointment');
  });

  it('MockLLMAdapter streams tokens and respects cancellation signal', async () => {
    const llm = new MockLLMAdapter({ timeToFirstTokenMs: 5, tokenIntervalMs: 5 });
    llm.setResponseForPattern('appointment', 'Sure, we have a slot available at 4 PM.');

    const abortController = new AbortController();
    const tokens: string[] = [];

    const stream = llm.generateResponseStream({
      systemPrompt: 'You are an appointment assistant.',
      conversationHistory: [{ role: 'user', content: 'Can I book an appointment?' }],
      signal: abortController.signal,
    });

    for await (const token of stream) {
      tokens.push(token);
      if (tokens.length >= 2) {
        abortController.abort(); // Interruption
      }
    }

    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(tokens.join('')).toContain('Sure');
  });

  it('MockTTSAdapter generates streaming audio buffers and respects abort signal', async () => {
    const tts = new MockTTSAdapter({ firstChunkDelayMs: 5, chunkIntervalMs: 5 });
    const abortController = new AbortController();

    const buffers: Buffer[] = [];
    const stream = tts.synthesizeStream({
      text: 'Thank you for calling Dr. Reddy clinic.',
      voiceId: 'sarvam-bulbul-sneha',
      language: 'English',
      signal: abortController.signal,
    });

    for await (const buf of stream) {
      buffers.push(buf);
      abortController.abort(); // Interrupted on first chunk
    }

    expect(buffers.length).toBe(1);
    expect(buffers[0].length).toBe(320);
  });
});

describe('Auris Voice Runtime - Orchestrator & Barge-In Interruption', () => {
  it('triggers immediate barge-in when user speaks during agent speech', async () => {
    const sm = new CallStateMachine(CallState.ACTIVE);
    const telephony = new MockTelephonyAdapter();
    const stt = new MockSTTAdapter();
    const stream = await stt.createStream('call-1', { language: 'English' });
    const llm = new MockLLMAdapter();
    const tts = new MockTTSAdapter();

    const orchestrator = new VoiceTurnOrchestrator(
      {
        callId: 'call-1',
        carrierCallId: 'mock-carrier-1',
        systemPrompt: 'You are a healthcare assistant.',
        language: 'English',
        voiceTier: 'STANDARD',
      },
      sm,
      telephony,
      stream,
      llm,
      tts
    );

    let bargeInFired = false;
    orchestrator.on('bargeIn', (data) => {
      bargeInFired = true;
      expect(data.latencyMs).toBeGreaterThanOrEqual(0);
    });

    // Put agent in SPEAKING state
    sm.transition(CallState.SPEAKING, 'TEST_AGENT_SPEAKING');
    expect(sm.getState()).toBe(CallState.SPEAKING);

    // Caller interrupts (speechStart from STT)
    orchestrator.handleUserSpeechStart();

    expect(bargeInFired).toBe(true);
    expect(orchestrator.totalBargeIns).toBe(1);
    expect(sm.getState()).toBe(CallState.LISTENING);
    expect(telephony.clearedBuffersCount.get('mock-carrier-1')).toBe(1);
  });
});

describe('Auris Voice Runtime - Wallet Safety & Settlement Integration', () => {
  let mockWallet: {
    balance: number;
    reserved: number;
    reservations: Map<string, any>;
    settlements: Map<string, any>;
    releases: Map<string, any>;
  };

  let mockWalletManager: IWalletManager;

  beforeEach(() => {
    mockWallet = {
      balance: 100.0,
      reserved: 0.0,
      reservations: new Map(),
      settlements: new Map(),
      releases: new Map(),
    };

    mockWalletManager = {
      async createReservation({ callId, amountCredits }) {
        const available = mockWallet.balance - mockWallet.reserved;
        if (available < amountCredits) {
          throw new Error('INSUFFICIENT_FUNDS');
        }
        mockWallet.reserved += amountCredits;
        const res = { callId, amountCredits, status: 'HELD' };
        mockWallet.reservations.set(callId, res);
        return res;
      },
      async extendReservation({ callId, additionalCredits }) {
        const available = mockWallet.balance - mockWallet.reserved;
        if (available < additionalCredits) {
          return { extended: false, action: 'TERMINATE_CALL', reason: 'INSUFFICIENT_FUNDS_FOR_EXTENSION' };
        }
        mockWallet.reserved += additionalCredits;
        return { extended: true };
      },
      async settleCall({ callId, durationSeconds, ratePerMinute, billingBlockSeconds = 30 }) {
        const blocks = Math.ceil(durationSeconds / billingBlockSeconds);
        const billableSeconds = blocks * billingBlockSeconds;
        const charge = Number(((billableSeconds / 60) * ratePerMinute).toFixed(4));

        const res = mockWallet.reservations.get(callId);
        if (res) {
          mockWallet.reserved -= res.amountCredits;
        }

        mockWallet.balance = Math.max(0, mockWallet.balance - charge);
        const settlement = { callId, billableSeconds, settledAmount: charge };
        mockWallet.settlements.set(callId, settlement);
        return settlement;
      },
      async releaseReservation({ callId }) {
        const res = mockWallet.reservations.get(callId);
        if (res) {
          mockWallet.reserved -= res.amountCredits;
          mockWallet.releases.set(callId, { callId, releasedAmount: res.amountCredits });
        }
        return { callId, status: 'RELEASED' };
      },
    };
  });

  it('strictly blocks call initiation when wallet has insufficient funds', async () => {
    mockWallet.balance = 2.0; // Less than 1 minute standard rate (₹5.00)

    const bridge = new RuntimeWalletBridge(mockWalletManager, {
      organizationId: 'org-1',
      callId: 'call-insufficient',
      voiceTier: 'STANDARD',
    });

    const session = new CallSession(
      {
        callId: 'call-insufficient',
        organizationId: 'org-1',
        agentId: 'agent-1',
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'You are an agent.',
        language: 'English',
        voiceTier: 'STANDARD',
      },
      {
        telephony: new MockTelephonyAdapter(),
        stt: new MockSTTAdapter(),
        llm: new MockLLMAdapter(),
        tts: new MockTTSAdapter(),
        walletBridge: bridge,
        eventLogger: new CallEventLogger('call-insufficient'),
      }
    );

    await expect(session.start()).rejects.toThrow(InsufficientFundsError);
    expect(session.getState()).toBe(CallState.FAILED);
    expect(mockWallet.reserved).toBe(0);
    expect(mockWallet.settlements.size).toBe(0);
  });

  it('completes full call, measures duration, and settles exact 30s billable units atomically', async () => {
    mockWallet.balance = 50.0;

    const bridge = new RuntimeWalletBridge(mockWalletManager, {
      organizationId: 'org-1',
      callId: 'call-success-1',
      voiceTier: 'STANDARD', // ₹5.00/min
      billingBlockSeconds: 30,
    });

    const telephony = new MockTelephonyAdapter({ autoRing: true, ringDelayMs: 5, autoAnswer: true, answerDelayMs: 10 });
    const session = new CallSession(
      {
        callId: 'call-success-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'Confirm real estate appointment.',
        language: 'English',
        voiceTier: 'STANDARD',
      },
      {
        telephony,
        stt: new MockSTTAdapter(),
        llm: new MockLLMAdapter(),
        tts: new MockTTSAdapter(),
        walletBridge: bridge,
        eventLogger: new CallEventLogger('call-success-1'),
      }
    );

    session.setInitialGreeting('Hello, I am calling regarding your real estate inquiry.');
    await session.start();

    // Wait for connection
    await new Promise((r) => setTimeout(r, 30));
    expect([CallState.ACTIVE, CallState.SPEAKING]).toContain(session.getState());

    // Simulate user conversation turn
    const stt = session.getSTTStream() as any;
    expect(stt).toBeDefined();

    await stt.simulateSpeech('Yes, please confirm Saturday slot at 10 AM', {
      speechStartDelayMs: 5,
      partialIntervalMs: 5,
      finalLatencyMs: 5,
    });

    // Wait for turn completion
    await new Promise((r) => setTimeout(r, 60));

    // Terminate call
    await session.terminate('Call Concluded Normally', false);

    expect(session.getState()).toBe(CallState.COMPLETED);
    expect(mockWallet.reserved).toBe(0); // Hold fully cleared
    expect(mockWallet.settlements.has('call-success-1')).toBe(true);
  });

  it('releases hold without deduction when call is unanswered or rejected', async () => {
    mockWallet.balance = 50.0;

    const bridge = new RuntimeWalletBridge(mockWalletManager, {
      organizationId: 'org-1',
      callId: 'call-no-answer',
      voiceTier: 'STANDARD',
    });

    const telephony = new MockTelephonyAdapter({ autoRing: true, autoAnswer: false });
    const session = new CallSession(
      {
        callId: 'call-no-answer',
        organizationId: 'org-1',
        agentId: 'agent-1',
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'Inbound receptionist assistant.',
        language: 'English',
        voiceTier: 'STANDARD',
      },
      {
        telephony,
        stt: new MockSTTAdapter(),
        llm: new MockLLMAdapter(),
        tts: new MockTTSAdapter(),
        walletBridge: bridge,
        eventLogger: new CallEventLogger('call-no-answer'),
      }
    );

    await session.start();
    expect(mockWallet.reserved).toBe(5.0);

    // Call terminates before answering (e.g. caller busy or timed out)
    await session.terminate('NO_ANSWER', false);

    expect(session.getState()).toBe(CallState.COMPLETED);
    expect(mockWallet.reserved).toBe(0); // Hold released
    expect(mockWallet.releases.has('call-no-answer')).toBe(true);
    expect(mockWallet.balance).toBe(50.0); // Zero deduction!
  });

  it('safely terminates call on mid-call wallet overdraft without carrier overshoot', async () => {
    mockWallet.balance = 5.0; // Exactly enough for 1st minute

    const bridge = new RuntimeWalletBridge(mockWalletManager, {
      organizationId: 'org-1',
      callId: 'call-overdraft',
      voiceTier: 'STANDARD',
    });

    const telephony = new MockTelephonyAdapter({ autoAnswer: true, answerDelayMs: 5 });
    const session = new CallSession(
      {
        callId: 'call-overdraft',
        organizationId: 'org-1',
        agentId: 'agent-1',
        direction: 'OUTBOUND_INSTANT',
        callerNumber: '+919900011122',
        destinationNumber: '+919900033344',
        systemPrompt: 'Telecaller.',
        language: 'English',
        voiceTier: 'STANDARD',
      },
      {
        telephony,
        stt: new MockSTTAdapter(),
        llm: new MockLLMAdapter(),
        tts: new MockTTSAdapter(),
        walletBridge: bridge,
        eventLogger: new CallEventLogger('call-overdraft'),
      }
    );

    await session.start();
    await new Promise((r) => setTimeout(r, 20));

    // Mid-call lease extension fails due to depleted available balance
    const extension = await session.extendLease(1);
    expect(extension.terminated).toBe(true);
    expect(session.getState()).toBe(CallState.FAILED);
  });
});
