import { EventEmitter } from 'events';
import {
  ITelephonyProvider,
  TelephonyInitiateParams,
  TelephonyInitiateResult,
} from '../../interfaces/telephony.interface.js';

export interface MockTelephonyOptions {
  autoRing?: boolean;
  ringDelayMs?: number;
  autoAnswer?: boolean;
  answerDelayMs?: number;
  failInitiate?: boolean;
  failInitiateReason?: string;
  failAnswer?: boolean;
}

export class MockTelephonyAdapter extends EventEmitter implements ITelephonyProvider {
  public name = 'mock-telephony';
  public readonly sentAudioChunks: Map<string, Buffer[]> = new Map();
  public readonly clearedBuffersCount: Map<string, number> = new Map();
  public activeCalls: Map<string, { params: TelephonyInitiateParams; status: 'ringing' | 'connected' | 'ended' }> = new Map();

  private options: MockTelephonyOptions;

  constructor(options: MockTelephonyOptions = {}) {
    super();
    this.options = {
      autoRing: true,
      ringDelayMs: 20,
      autoAnswer: true,
      answerDelayMs: 50,
      ...options,
    };
  }

  setOptions(options: Partial<MockTelephonyOptions>) {
    this.options = { ...this.options, ...options };
  }

  async initiateCall(params: TelephonyInitiateParams): Promise<TelephonyInitiateResult> {
    if (this.options.failInitiate) {
      const err = new Error(this.options.failInitiateReason || 'MOCK_CARRIER_REJECTED');
      this.emit('error', { carrierCallId: '', error: err });
      throw err;
    }

    const carrierCallId = `mock-carrier-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.sentAudioChunks.set(carrierCallId, []);
    this.clearedBuffersCount.set(carrierCallId, 0);

    const callRecord = { params, status: 'ringing' as const };
    this.activeCalls.set(carrierCallId, callRecord);

    if (this.options.autoRing) {
      setTimeout(() => {
        if (this.activeCalls.has(carrierCallId)) {
          this.emit('ringing', { carrierCallId });
        }
      }, this.options.ringDelayMs);
    }

    if (this.options.autoAnswer) {
      setTimeout(async () => {
        if (this.activeCalls.has(carrierCallId) && !this.options.failAnswer) {
          await this.answerCall(carrierCallId);
        } else if (this.options.failAnswer) {
          this.emit('error', { carrierCallId, error: new Error('MOCK_ANSWER_TIMEOUT') });
        }
      }, (this.options.ringDelayMs ?? 20) + (this.options.answerDelayMs ?? 50));
    }

    return { carrierCallId, status: 'ringing' };
  }

  async answerCall(carrierCallId: string): Promise<void> {
    const call = this.activeCalls.get(carrierCallId);
    if (!call) throw new Error(`Carrier call ${carrierCallId} not found`);

    call.status = 'connected';
    this.emit('connected', { carrierCallId, timestamp: Date.now() });
  }

  async hangupCall(carrierCallId: string, reason = 'NORMAL_HANGUP'): Promise<void> {
    const call = this.activeCalls.get(carrierCallId);
    if (call) {
      call.status = 'ended';
      this.activeCalls.delete(carrierCallId);
    }
    this.emit('disconnected', { carrierCallId, reason, timestamp: Date.now() });
  }

  async sendAudioChunk(carrierCallId: string, audio: Buffer): Promise<void> {
    const chunks = this.sentAudioChunks.get(carrierCallId) || [];
    chunks.push(audio);
    this.sentAudioChunks.set(carrierCallId, chunks);
    this.emit('carrierAudioSent', { carrierCallId, bytes: audio.length });
  }

  async clearAudioBuffer(carrierCallId: string): Promise<void> {
    const count = (this.clearedBuffersCount.get(carrierCallId) || 0) + 1;
    this.clearedBuffersCount.set(carrierCallId, count);
    this.sentAudioChunks.set(carrierCallId, []);
    this.emit('bufferCleared', { carrierCallId });
  }

  // Simulator helper: simulate caller speaking into carrier
  simulateCallerAudio(carrierCallId: string, audio: Buffer): void {
    this.emit('audioChunk', { carrierCallId, audio });
  }

  // Simulator helper: simulate remote party hanging up
  simulateRemoteHangup(carrierCallId: string, reason = 'REMOTE_PARTY_DISCONNECT'): void {
    this.hangupCall(carrierCallId, reason).catch(() => {});
  }

  // Simulator helper: simulate incoming call from PSTN
  simulateIncomingCall(params: { from: string; to: string; callId: string }): string {
    const carrierCallId = `mock-inbound-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.sentAudioChunks.set(carrierCallId, []);
    this.clearedBuffersCount.set(carrierCallId, 0);
    this.activeCalls.set(carrierCallId, {
      params: { ...params, direction: 'INBOUND' },
      status: 'ringing',
    });
    return carrierCallId;
  }
}
