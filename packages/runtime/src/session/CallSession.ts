import { EventEmitter } from 'events';
import { CallStateMachine } from '../state-machine/CallStateMachine.js';
import { CallState, CallSessionConfig, StageLatencies } from '../types/session.types.js';
import { ITelephonyProvider } from '../interfaces/telephony.interface.js';
import { ISTTProvider, ISTTStream } from '../interfaces/stt.interface.js';
import { ILLMProvider } from '../interfaces/llm.interface.js';
import { ITTSProvider } from '../interfaces/tts.interface.js';
import { RuntimeWalletBridge } from '../wallet/RuntimeWalletBridge.js';
import { CallEventLogger } from '../events/CallEventLogger.js';
import { VoiceTurnOrchestrator } from '../orchestrator/VoiceTurnOrchestrator.js';

export interface CallSessionDependencies {
  telephony: ITelephonyProvider;
  stt: ISTTProvider;
  llm: ILLMProvider;
  tts: ITTSProvider;
  walletBridge: RuntimeWalletBridge;
  eventLogger: CallEventLogger;
}

export class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient wallet credits for pre-authorization hold') {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

export class CallSession extends EventEmitter {
  public readonly stateMachine: CallStateMachine;
  private readonly telephony: ITelephonyProvider;
  private readonly stt: ISTTProvider;
  private readonly llm: ILLMProvider;
  private readonly tts: ITTSProvider;
  private readonly walletBridge: RuntimeWalletBridge;
  private readonly eventLogger: CallEventLogger;

  private carrierCallId: string | null = null;
  private sttStream: ISTTStream | null = null;
  private orchestrator: VoiceTurnOrchestrator | null = null;

  private startedAt: Date | null = null;
  private endedAt: Date | null = null;
  private isAnswered = false;
  private terminationReason: string | null = null;
  private initialGreetingText: string | null = null;
  private terminationPromise: Promise<void> | null = null;

  constructor(
    public readonly config: CallSessionConfig,
    deps: CallSessionDependencies
  ) {
    super();
    this.telephony = deps.telephony;
    this.stt = deps.stt;
    this.llm = deps.llm;
    this.tts = deps.tts;
    this.walletBridge = deps.walletBridge;
    this.eventLogger = deps.eventLogger;

    this.stateMachine = new CallStateMachine(CallState.INITIALIZING);
    this.eventLogger.logEvent('SESSION_CREATED', undefined, CallState.INITIALIZING, {
      callId: config.callId,
      orgId: config.organizationId,
      agentId: config.agentId,
      direction: config.direction,
    });
  }

  getState(): CallState {
    return this.stateMachine.getState();
  }

  isTerminal(): boolean {
    return this.stateMachine.isTerminal();
  }

  getCarrierCallId(): string | null {
    return this.carrierCallId;
  }

  getOrchestrator(): VoiceTurnOrchestrator | null {
    return this.orchestrator;
  }

  getSTTStream(): ISTTStream | null {
    return this.sttStream;
  }

  setInitialGreeting(greeting: string) {
    this.initialGreetingText = greeting;
  }

  /**
   * Start the call lifecycle: Pre-auth Wallet Hold ➔ Telephony Dial/Connect ➔ STT/TTS Orchestration.
   */
  async start(): Promise<void> {
    // 1. Acquire Pre-Authorization Wallet Hold
    this.stateMachine.transition(CallState.RESERVING, 'PREAUTH_HOLD_REQUESTED');
    await this.eventLogger.logEvent('PREAUTH_HOLD_REQUESTED', CallState.INITIALIZING, CallState.RESERVING);

    try {
      const holdResult = await this.walletBridge.acquirePreAuthHold(1);
      await this.eventLogger.logEvent('PREAUTH_HOLD_ACQUIRED', CallState.RESERVING, CallState.RESERVING, holdResult);
    } catch (err: any) {
      this.terminationReason = 'INSUFFICIENT_FUNDS';
      this.stateMachine.transition(CallState.TERMINATING, 'PREAUTH_HOLD_FAILED', err.message);
      this.stateMachine.transition(CallState.FAILED, 'INSUFFICIENT_FUNDS', err.message);
      await this.eventLogger.logEvent('INSUFFICIENT_FUNDS_PREAUTH', CallState.RESERVING, CallState.FAILED, {
        error: err.message,
      });
      await this.eventLogger.finalizeCallRecord({
        status: 'FAILED',
        durationSeconds: 0,
        billableSeconds: 0,
        creditsDeducted: 0,
        endedAt: new Date(),
        terminationReason: 'INSUFFICIENT_FUNDS',
        outcome: 'CALL_FAILED',
      });
      throw new InsufficientFundsError(err.message);
    }

    // 2. Initiate Carrier Call Leg
    this.stateMachine.transition(CallState.RINGING, 'TELEPHONY_INITIATED');
    await this.eventLogger.logEvent('TELEPHONY_INITIATED', CallState.RESERVING, CallState.RINGING);

    try {
      const initiateResult = await this.telephony.initiateCall({
        callId: this.config.callId,
        from: this.config.callerNumber,
        to: this.config.destinationNumber,
        direction: this.config.direction,
      });

      this.carrierCallId = initiateResult.carrierCallId;
      this.attachTelephonyListeners();
    } catch (err: any) {
      await this.terminate(`CARRIER_INITIATE_FAILED: ${err.message}`, true);
      throw err;
    }
  }

  private attachTelephonyListeners() {
    if (!this.carrierCallId) return;

    // Carrier Ringing
    this.telephony.on('ringing', (data) => {
      if (data.carrierCallId === this.carrierCallId && this.stateMachine.getState() === CallState.RINGING) {
        this.eventLogger.logEvent('CARRIER_RINGING', CallState.RINGING, CallState.RINGING);
        this.emit('ringing', data);
      }
    });

    // Carrier Connected / Answered
    this.telephony.on('connected', async (data) => {
      if (data.carrierCallId === this.carrierCallId && this.stateMachine.getState() === CallState.RINGING) {
        await this.handleCallConnected();
      }
    });

    // Carrier Inbound Audio
    this.telephony.on('audioChunk', (data) => {
      if (data.carrierCallId === this.carrierCallId && this.sttStream) {
        this.sttStream.pushAudio(data.audio);
      }
    });

    // Carrier Disconnected / Hangup
    this.telephony.on('disconnected', async (data) => {
      if (data.carrierCallId === this.carrierCallId && !this.stateMachine.isTerminatingOrDone()) {
        await this.terminate(data.reason || 'CARRIER_DISCONNECT', false);
      }
    });

    // Carrier Error
    this.telephony.on('error', async (data) => {
      if (data.carrierCallId === this.carrierCallId && !this.stateMachine.isTerminatingOrDone()) {
        await this.terminate(`CARRIER_ERROR: ${data.error.message}`, true);
      }
    });
  }

  /**
   * Handle Call Connected / Answered.
   */
  public async handleCallConnected(): Promise<void> {
    this.isAnswered = true;
    this.startedAt = new Date();

    this.stateMachine.transition(CallState.ACTIVE, 'CALL_CONNECTED', 'Remote party answered carrier leg');
    await this.eventLogger.logEvent('CALL_CONNECTED', CallState.RINGING, CallState.ACTIVE, {
      startedAt: this.startedAt,
    });

    // Initialize Streaming STT
    this.sttStream = await this.stt.createStream(this.config.callId, {
      language: this.config.language,
      interruptionSensitivity: this.config.interruptionSensitivity,
    });

    // Initialize Voice Turn Orchestrator
    this.orchestrator = new VoiceTurnOrchestrator(
      {
        callId: this.config.callId,
        carrierCallId: this.carrierCallId!,
        systemPrompt: this.config.systemPrompt,
        language: this.config.language,
        voiceId: this.config.voiceId,
        voiceTier: this.config.voiceTier,
        llmTemperature: this.config.llmTemperature,
        interruptionSensitivity: this.config.interruptionSensitivity,
      },
      this.stateMachine,
      this.telephony,
      this.sttStream,
      this.llm,
      this.tts
    );

    // Forward turn events to logger and session emitter
    this.orchestrator.on('turnStart', (turn) => {
      this.eventLogger.logTranscript(turn.speaker, turn.text, turn.timestamp);
      this.emit('turnStart', turn);
    });

    this.orchestrator.on('turnComplete', (turn) => {
      this.eventLogger.logTranscript(turn.speaker, turn.text, Date.now());
      this.emit('turnComplete', turn);
    });

    this.orchestrator.on('bargeIn', (data) => {
      this.eventLogger.logEvent('BARGE_IN_TRIGGERED', CallState.SPEAKING, CallState.LISTENING, data, data.latencyMs);
      this.emit('bargeIn', data);
    });

    this.emit('connected', { startedAt: this.startedAt });

    // Play optional initial greeting
    if (this.initialGreetingText) {
      await this.orchestrator.playInitialGreeting(this.initialGreetingText);
    }
  }

  /**
   * Extend hold mid-call. If wallet balance is insufficient, gracefully terminates the call.
   */
  async extendLease(additionalMinutes = 1): Promise<{ extended: boolean; terminated: boolean }> {
    if (this.stateMachine.isTerminatingOrDone()) {
      return { extended: false, terminated: true };
    }

    const result = await this.walletBridge.extendHold(additionalMinutes);
    if (result.terminate) {
      await this.terminate('INSUFFICIENT_FUNDS_OVERDRAFT', true);
      return { extended: false, terminated: true };
    }

    await this.eventLogger.logEvent('HOLD_EXTENDED', this.stateMachine.getState(), this.stateMachine.getState(), {
      additionalMinutes,
    });
    return { extended: true, terminated: false };
  }

  /**
   * Idempotent termination.
   * Cleans up STT stream, settles/releases wallet hold, updates DB, and finalizes state.
   */
  async terminate(reason = 'Normal Hangup', failed = false): Promise<void> {
    if (this.stateMachine.isTerminal()) {
      return;
    }
    if (this.terminationPromise) {
      return this.terminationPromise;
    }

    this.terminationPromise = (async () => {
      try {
        this.endedAt = new Date();
        this.terminationReason = reason;

        // Transition to TERMINATING
        if (!this.stateMachine.isTerminatingOrDone()) {
          this.stateMachine.terminate(reason, failed);
        }

        await this.eventLogger.logEvent('TERMINATING_REQUESTED', undefined, CallState.TERMINATING, {
          reason,
          failed,
          endedAt: this.endedAt,
        });

        // 1. Clean up STT Stream & Telephony
        if (this.sttStream) {
          try {
            this.sttStream.abort();
          } catch {}
          this.sttStream = null;
        }

        if (this.carrierCallId) {
          try {
            await this.telephony.clearAudioBuffer(this.carrierCallId);
            await this.telephony.hangupCall(this.carrierCallId, reason);
          } catch {}
        }

        // 2. Transition to SETTLING
        if (this.stateMachine.getState() !== CallState.SETTLING) {
          this.stateMachine.transition(CallState.SETTLING, 'SETTLEMENT_INITIATED');
        }

        const durationSeconds = this.startedAt
          ? Math.max(this.isAnswered ? 1 : 0, Math.round((this.endedAt.getTime() - this.startedAt.getTime()) / 1000))
          : 0;

        const settlement = await this.walletBridge.finalizeSettlement(
          durationSeconds,
          this.isAnswered,
          reason
        );
        const settledAmount = settlement.amount;
        await this.eventLogger.logEvent('SETTLEMENT_COMPLETED', CallState.SETTLING, CallState.SETTLING, settlement);

        // 3. Finalize Call Record in Database
        const finalState = failed ? CallState.FAILED : CallState.COMPLETED;
        const finalOutcome = failed
          ? 'CALL_FAILED'
          : (this.isAnswered ? 'QUALIFIED' : 'NO_ANSWER');

        const billableSeconds = this.isAnswered
          ? Math.ceil(durationSeconds / 30) * 30
          : 0;

        await this.eventLogger.finalizeCallRecord({
          status: failed ? 'FAILED' : 'COMPLETED',
          durationSeconds,
          billableSeconds,
          creditsDeducted: settledAmount,
          startedAt: this.startedAt || undefined,
          endedAt: this.endedAt,
          terminationReason: reason,
          outcome: finalOutcome,
        });

        // 4. Final Transition
        this.stateMachine.transition(finalState, 'CALL_FINALIZED', reason, {
          durationSeconds,
          settledAmount,
          isAnswered: this.isAnswered,
        });

        await this.eventLogger.logEvent('CALL_FINALIZED', CallState.SETTLING, finalState, {
          durationSeconds,
          settledAmount,
        });

        this.emit('callEnded', {
          callId: this.config.callId,
          state: finalState,
          durationSeconds,
          settledAmount,
          reason,
          history: this.orchestrator ? this.orchestrator.getHistory() : [],
        });
      } catch (err) {
        if (!this.stateMachine.isTerminal()) {
          this.terminationPromise = null;
        }
        throw err;
      }
    })();

    return this.terminationPromise;
  }
}
