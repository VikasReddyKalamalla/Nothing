import { EventEmitter } from 'events';
import { AudioFrame, NormalizedTelephonyEvent } from './TelephonyTypes.js';

export interface ITelephonyConnection extends EventEmitter {
  readonly callId: string;
  readonly providerCallReference: string;
  readonly status: 'connecting' | 'open' | 'closed';

  /**
   * Send an outgoing audio frame to the provider stream.
   */
  sendAudioFrame(frame: AudioFrame): Promise<void>;

  /**
   * Clear any buffered outbound audio on the provider stream (barge-in flush).
   */
  clearBuffer(): Promise<void>;

  /**
   * Gracefully close the connection.
   */
  close(reason?: string): Promise<void>;

  /**
   * Abruptly terminate the connection with an error.
   */
  abort(err: Error): void;
}
