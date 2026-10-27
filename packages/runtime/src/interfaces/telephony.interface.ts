import { EventEmitter } from 'events';
import { CallDirection } from '../types/session.types.js';

export interface TelephonyInitiateParams {
  callId: string;
  from: string;
  to: string;
  direction: CallDirection;
  metadata?: Record<string, any>;
}

export interface TelephonyInitiateResult {
  carrierCallId: string;
  status: 'ringing' | 'connected';
}

export interface ITelephonyProvider extends EventEmitter {
  name: string;

  /**
   * Initiate an outbound carrier leg or accept an inbound connection.
   */
  initiateCall(params: TelephonyInitiateParams): Promise<TelephonyInitiateResult>;

  /**
   * Answer an inbound call leg.
   */
  answerCall(carrierCallId: string): Promise<void>;

  /**
   * Terminate the carrier call leg.
   */
  hangupCall(carrierCallId: string, reason?: string): Promise<void>;

  /**
   * Send an audio chunk (PCM/WAV) to the telephony carrier stream.
   */
  sendAudioChunk(carrierCallId: string, audio: Buffer): Promise<void>;

  /**
   * Flush/clear buffered outbound audio on carrier (essential for barge-in / speech interruption).
   */
  clearAudioBuffer(carrierCallId: string): Promise<void>;
}
