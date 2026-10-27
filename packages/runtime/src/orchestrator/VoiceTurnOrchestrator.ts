import { EventEmitter } from 'events';
import { CallStateMachine } from '../state-machine/CallStateMachine.js';
import { CallState, StageLatencies, ConversationTurn } from '../types/session.types.js';
import { ITelephonyProvider } from '../interfaces/telephony.interface.js';
import { ISTTStream } from '../interfaces/stt.interface.js';
import { ILLMProvider, ChatMessage } from '../interfaces/llm.interface.js';
import { ITTSProvider } from '../interfaces/tts.interface.js';

export interface TurnOrchestratorConfig {
  callId: string;
  carrierCallId: string;
  systemPrompt: string;
  language: string;
  voiceId?: string;
  voiceTier?: 'STANDARD' | 'PREMIUM' | 'ULTRA';
  llmTemperature?: number;
  interruptionSensitivity?: number;
}

export class VoiceTurnOrchestrator extends EventEmitter {
  private readonly conversationHistory: ChatMessage[] = [];
  private currentTurnAbortController: AbortController | null = null;
  private isProcessingTurn = false;
  private turnCounter = 0;
  public lastLatencies: StageLatencies = {};
  public totalBargeIns = 0;

  constructor(
    private readonly config: TurnOrchestratorConfig,
    private readonly stateMachine: CallStateMachine,
    private readonly telephony: ITelephonyProvider,
    private readonly sttStream: ISTTStream,
    private readonly llm: ILLMProvider,
    private readonly tts: ITTSProvider
  ) {
    super();
    this.conversationHistory.push({
      role: 'system',
      content: this.config.systemPrompt,
    });
    this.attachSTTListeners();
  }

  getHistory(): ReadonlyArray<ChatMessage> {
    return this.conversationHistory;
  }

  private attachSTTListeners() {
    // 1. User starts speaking
    this.sttStream.on('speechStart', () => {
      this.handleUserSpeechStart();
    });

    // 2. Partial transcript
    this.sttStream.on('partialTranscript', (partial: string) => {
      this.emit('userPartialTranscript', { callId: this.config.callId, transcript: partial });
    });

    // 3. Final transcript
    this.sttStream.on('finalTranscript', (transcript: string, sttLatencyMs?: number) => {
      this.handleUserFinalTranscript(transcript, sttLatencyMs);
    });

    // 4. STT Error
    this.sttStream.on('error', (err: Error) => {
      this.emit('error', { stage: 'stt', error: err });
    });
  }

  /**
   * Handle Voice Activity Detection (VAD) / Speech Start.
   * If agent is in SPEAKING state, triggers Barge-in interruption.
   */
  public handleUserSpeechStart() {
    if (this.stateMachine.isTerminatingOrDone()) {
      return;
    }

    const currentState = this.stateMachine.getState();
    const now = Date.now();

    if (currentState === CallState.SPEAKING || (this.isProcessingTurn && this.currentTurnAbortController)) {
      // BARGE-IN DETECTED!
      this.totalBargeIns++;
      const bargeInStart = now;

      // 1. Abort ongoing LLM generation and TTS streaming immediately
      if (this.currentTurnAbortController) {
        this.currentTurnAbortController.abort('USER_BARGE_IN');
        this.currentTurnAbortController = null;
      }
      this.isProcessingTurn = false;

      // 2. Clear telephony audio playback buffer on carrier
      this.telephony.clearAudioBuffer(this.config.carrierCallId).catch(() => {});

      // 3. Measure barge-in response latency
      const bargeInLatencyMs = Date.now() - bargeInStart;
      this.lastLatencies.bargeInLatencyMs = bargeInLatencyMs;

      // 4. Transition state machine to LISTENING
      if (this.stateMachine.getState() !== CallState.LISTENING) {
        this.stateMachine.transition(
          CallState.LISTENING,
          'USER_BARGE_IN',
          'Caller began speaking during agent speech',
          { bargeInLatencyMs }
        );
      }

      this.emit('bargeIn', {
        callId: this.config.callId,
        latencyMs: bargeInLatencyMs,
        timestamp: now,
      });
    } else if (currentState === CallState.ACTIVE || currentState === CallState.PROCESSING) {
      this.stateMachine.transition(CallState.LISTENING, 'USER_SPEECH_START');
    }
  }

  /**
   * Process a finalized user transcript turn.
   */
  public async handleUserFinalTranscript(transcript: string, sttLatencyMs: number = 0) {
    if (this.stateMachine.isTerminatingOrDone()) {
      return;
    }

    const trimmed = transcript.trim();
    if (!trimmed) {
      if (this.stateMachine.getState() === CallState.LISTENING) {
        this.stateMachine.transition(CallState.ACTIVE, 'EMPTY_SPEECH_IGNORED');
      }
      return;
    }

    const turnStartTime = Date.now();
    this.turnCounter++;
    const turnId = `turn-${this.turnCounter}`;

    // Record Caller transcript in conversation history
    this.conversationHistory.push({ role: 'user', content: trimmed });

    this.lastLatencies = {
      sttLatencyMs,
    };

    this.emit('turnStart', {
      turnId,
      speaker: 'CALLER',
      text: trimmed,
      sttLatencyMs,
      timestamp: turnStartTime,
    });

    // Transition to PROCESSING
    this.stateMachine.transition(CallState.PROCESSING, 'USER_SPEECH_FINALIZED', undefined, {
      turnId,
      sttLatencyMs,
    });

    await this.executeAgentResponseTurn(turnId, turnStartTime);
  }

  /**
   * Execute an Agent Response Turn:
   * Queries LLM ➔ Accumulates Sentences ➔ Synthesizes TTS ➔ Emits to Telephony.
   */
  public async executeAgentResponseTurn(turnId: string, turnStartTime: number) {
    this.isProcessingTurn = true;
    const abortController = new AbortController();
    this.currentTurnAbortController = abortController;
    const signal = abortController.signal;

    let fullAgentResponse = '';
    let sentenceBuffer = '';
    let isFirstToken = true;
    let isFirstTtsChunk = true;

    try {
      const llmStartTime = Date.now();
      const tokenStream = this.llm.generateResponseStream({
        systemPrompt: this.config.systemPrompt,
        conversationHistory: this.conversationHistory,
        temperature: this.config.llmTemperature ?? 0.3,
        signal,
      });

      for await (const token of tokenStream) {
        if (signal.aborted) break;

        if (isFirstToken) {
          isFirstToken = false;
          this.lastLatencies.llmFirstTokenMs = Date.now() - llmStartTime;
          this.emit('llmFirstToken', {
            turnId,
            latencyMs: this.lastLatencies.llmFirstTokenMs,
          });
        }

        fullAgentResponse += token;
        sentenceBuffer += token;

        // Sentence boundary detection for low-latency streaming TTS
        if (this.isSentenceBoundary(sentenceBuffer)) {
          const sentenceToSpeak = sentenceBuffer.trim();
          sentenceBuffer = '';

          if (sentenceToSpeak.length > 0 && !signal.aborted) {
            await this.synthesizeAndPlaySentence(sentenceToSpeak, turnId, signal, () => {
              if (isFirstTtsChunk) {
                isFirstTtsChunk = false;
                this.lastLatencies.ttsFirstChunkMs = Date.now() - llmStartTime;
                this.lastLatencies.totalTurnaroundMs = Date.now() - turnStartTime;
                this.emit('turnaroundReady', {
                  turnId,
                  latencies: this.lastLatencies,
                });
              }
            });
          }
        }
      }

      // Flush any trailing sentence content
      if (!signal.aborted && sentenceBuffer.trim().length > 0) {
        await this.synthesizeAndPlaySentence(sentenceBuffer.trim(), turnId, signal);
      }

      if (!signal.aborted && fullAgentResponse.trim().length > 0) {
        this.conversationHistory.push({
          role: 'assistant',
          content: fullAgentResponse.trim(),
        });

        this.emit('turnComplete', {
          turnId,
          speaker: 'AGENT',
          text: fullAgentResponse.trim(),
          latencies: this.lastLatencies,
        });

        // Return to LISTENING or ACTIVE state
        if (this.stateMachine.getState() === CallState.SPEAKING) {
          this.stateMachine.transition(CallState.LISTENING, 'AGENT_FINISHED_SPEAKING');
        }
      }
    } catch (err: any) {
      if (signal.aborted || err.name === 'AbortError') {
        this.emit('interrupted', { turnId, reason: 'USER_BARGE_IN' });
      } else {
        this.emit('error', { stage: 'orchestrator_turn', error: err });
      }
    } finally {
      this.isProcessingTurn = false;
      if (this.currentTurnAbortController === abortController) {
        this.currentTurnAbortController = null;
      }
    }
  }

  /**
   * Synthesize a text sentence into streaming audio and emit to carrier.
   */
  private async synthesizeAndPlaySentence(
    text: string,
    turnId: string,
    signal: AbortSignal,
    onFirstChunk?: () => void
  ): Promise<void> {
    if (signal.aborted || this.stateMachine.isTerminatingOrDone()) return;

    // Transition state machine to SPEAKING
    if (this.stateMachine.getState() !== CallState.SPEAKING) {
      this.stateMachine.transition(CallState.SPEAKING, 'AGENT_START_SPEAKING', undefined, { turnId });
    }

    const audioStream = this.tts.synthesizeStream({
      text,
      voiceId: this.config.voiceId || 'sarvam-bulbul-sneha',
      language: this.config.language,
      voiceTier: this.config.voiceTier,
      signal,
    });

    for await (const audioChunk of audioStream) {
      if (signal.aborted) break;

      if (onFirstChunk) {
        onFirstChunk();
        onFirstChunk = undefined;
      }

      await this.telephony.sendAudioChunk(this.config.carrierCallId, audioChunk);
    }
  }

  private isSentenceBoundary(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 12) return false;
    return /[.!?\n]$/.test(trimmed) || trimmed.endsWith(';') || trimmed.endsWith(':');
  }

  /**
   * Trigger initial greeting for outbound or receptionist sessions.
   */
  public async playInitialGreeting(greetingText: string) {
    const turnStartTime = Date.now();
    this.turnCounter++;
    const turnId = `greeting-${this.turnCounter}`;

    this.conversationHistory.push({
      role: 'assistant',
      content: greetingText,
    });

    const abortController = new AbortController();
    this.currentTurnAbortController = abortController;
    const signal = abortController.signal;

    try {
      await this.synthesizeAndPlaySentence(greetingText, turnId, signal);

      this.emit('turnComplete', {
        turnId,
        speaker: 'AGENT',
        text: greetingText,
        latencies: { totalTurnaroundMs: Date.now() - turnStartTime },
      });

      if (this.stateMachine.getState() === CallState.SPEAKING) {
        this.stateMachine.transition(CallState.LISTENING, 'GREETING_FINISHED');
      }
    } catch (err: any) {
      if (!signal.aborted) {
        this.emit('error', { stage: 'greeting', error: err });
      }
    } finally {
      if (this.currentTurnAbortController === abortController) {
        this.currentTurnAbortController = null;
      }
    }
  }
}
