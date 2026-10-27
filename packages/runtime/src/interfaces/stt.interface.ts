import { EventEmitter } from 'events';

export interface STTConfig {
  language: string;
  sampleRate?: number;
  encoding?: string;
  interruptionSensitivity?: number;
}

export interface ISTTStream extends EventEmitter {
  /**
   * Push raw audio bytes from telephony into speech recognition pipeline.
   */
  pushAudio(chunk: Buffer): void;

  /**
   * Complete the audio stream and wait for pending recognition.
   */
  finish(): Promise<void>;

  /**
   * Immediately abort speech recognition.
   */
  abort(): void;
}

export interface ISTTProvider {
  name: string;

  /**
   * Initialize a bidirectional streaming speech recognition session.
   */
  createStream(callId: string, config: STTConfig): Promise<ISTTStream>;
}
