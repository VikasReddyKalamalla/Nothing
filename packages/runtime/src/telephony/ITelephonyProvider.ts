import {
  AudioFrame,
  NormalizedTelephonyEvent,
  TelephonyCapabilities,
} from './TelephonyTypes.js';
import { ITelephonyConnection } from './ITelephonyConnection.js';

export interface WebhookContext {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

export interface ITelephonyGatewayProvider {
  readonly providerId: string;
  readonly capabilities: TelephonyCapabilities;

  /**
   * Validate and normalize an inbound or lifecycle webhook payload into a normalized telephony event.
   */
  normalizeWebhook(context: WebhookContext): NormalizedTelephonyEvent;

  /**
   * Parse a raw transport message (e.g. WebSocket frame) into a normalized audio frame or control event.
   */
  parseMediaMessage(rawMessage: string | Buffer, callId: string): AudioFrame | NormalizedTelephonyEvent;

  /**
   * Encode an outgoing internal AudioFrame into the provider's transport framing format.
   */
  encodeMediaMessage(frame: AudioFrame, streamId?: string): string | Buffer;

  /**
   * Encode a control message (e.g. clear/flush, stop) into the provider's transport framing format.
   */
  encodeControlMessage(type: 'clear' | 'stop', streamId?: string, details?: Record<string, any>): string | Buffer;

  /**
   * Create or bind a provider connection for an active call session.
   */
  createConnection(callId: string, providerCallReference: string): ITelephonyConnection;

  /**
   * Deterministically dispose provider resources.
   */
  dispose(): Promise<void>;
}
