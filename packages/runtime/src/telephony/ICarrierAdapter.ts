import { AudioEncoding } from './TelephonyTypes.js';

export interface CarrierCapabilities {
  supportsInbound: boolean;
  supportsOutbound: boolean;
  supportsBidiStreaming: boolean;
  supportsBargeInFlush: boolean;
  supportedEncodings: AudioEncoding[];
  maxFrameDurationMs: number;
  maxFrameSizeBytes: number;
}

export interface OutboundCallRequest {
  callId: string;
  from: string;
  to: string;
  direction?: 'OUTBOUND' | 'INBOUND';
  metadata?: Record<string, unknown>;
}

export type CarrierCallStatus =
  | 'initiated'
  | 'ringing'
  | 'connected'
  | 'busy'
  | 'no_answer'
  | 'failed'
  | 'completed'
  | 'rejected'
  | 'cancelled';

export interface CarrierCallResult {
  carrierCallId: string;
  status: CarrierCallStatus;
  providerId: string;
  timestamp: number;
}

export interface TerminateCarrierCallRequest {
  carrierCallId: string;
  reason?: string;
}

export type NormalizedCarrierEventType =
  | 'call.offered'
  | 'call.initiated'
  | 'call.ringing'
  | 'call.answered'
  | 'media.requested'
  | 'media.connected'
  | 'media.disconnected'
  | 'call.completed'
  | 'call.failed'
  | 'call.rejected'
  | 'call.busy'
  | 'call.unanswered'
  | 'call.cancelled'
  | 'transport.error';

export interface NormalizedCarrierEvent {
  eventId: string;
  providerEventId?: string;
  providerId: string;
  eventType: NormalizedCarrierEventType;
  carrierCallId: string;
  callId?: string;
  timestamp: number;
  payload: Record<string, unknown>;
  correlationId?: string;
  sequenceNumber?: number;
  payloadFingerprint?: string;
}

export interface CarrierHealthResult {
  healthy: boolean;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface ICarrierAdapter {
  readonly id: string;
  readonly capabilities: CarrierCapabilities;

  /**
   * Initiate an outbound carrier leg.
   */
  initiateOutboundCall(request: OutboundCallRequest): Promise<CarrierCallResult>;

  /**
   * Terminate or cancel an active carrier call leg.
   */
  terminateCall(request: TerminateCarrierCallRequest): Promise<void>;

  /**
   * Normalize an untrusted carrier event or webhook payload into a canonical NormalizedCarrierEvent.
   * Throws TelephonyError if malformed or invalid.
   */
  normalizeEvent(input: unknown): NormalizedCarrierEvent;

  /**
   * Check adapter health and availability.
   */
  getHealth(): Promise<CarrierHealthResult>;

  /**
   * Deterministically dispose adapter resources and clear active timers/listeners.
   */
  dispose(): Promise<void>;
}
