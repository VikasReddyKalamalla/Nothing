import { Buffer } from 'node:buffer';

export type TelephonyEventType =
  | 'call.initiated'
  | 'call.ringing'
  | 'call.answered'
  | 'call.disconnected'
  | 'call.failed'
  | 'media.started'
  | 'media.stopped'
  | 'media.error';

export type AudioEncoding = 'pcm_16000' | 'pcm_8000' | 'mulaw_8000';

export interface AudioFrame {
  callId: string;
  payloadBytes: Buffer;
  encoding: AudioEncoding;
  sampleRate: number;
  channels: number;
  sequenceNumber?: number;
  timestampMs?: number;
}

export interface NormalizedTelephonyEvent {
  eventId: string;
  providerEventId?: string;
  providerId: string;
  eventType: TelephonyEventType;
  providerCallReference: string;
  callId?: string;
  timestamp: number;
  payload: Record<string, any>;
}

export interface TelephonyCapabilities {
  supportsBidiStreaming: boolean;
  supportedEncodings: AudioEncoding[];
  supportsBargeInFlush: boolean;
  maxFrameDurationMs: number;
  maxFrameSizeBytes: number;
}

export interface StreamTokenPayload {
  callId: string;
  organizationId: string;
  purpose: 'media_stream';
  expiresAt: number;
  nonce: string;
}

export type WebhookVerificationFailureReason =
  | 'VALID'
  | 'MISSING_SIGNATURE'
  | 'INVALID_SIGNATURE'
  | 'EXPIRED_TIMESTAMP'
  | 'REPLAY_DETECTED'
  | 'MALFORMED_HEADER'
  | 'MISSING_SECRET';

export interface WebhookVerificationResult {
  valid: boolean;
  reason: WebhookVerificationFailureReason;
  timestamp?: number;
}

export interface MediaQueueConfig {
  maxQueuedFrames: number;
  maxQueuedBytes: number;
  maxFrameSize: number;
  maxMessageSize: number;
  idleTimeoutMs: number;
}

export const DEFAULT_MEDIA_CONFIG: MediaQueueConfig = {
  maxQueuedFrames: 50,
  maxQueuedBytes: 64 * 1024, // 64 KB
  maxFrameSize: 4096, // 4 KB per frame (20ms PCM 16k is 640 bytes)
  maxMessageSize: 16 * 1024, // 16 KB JSON message
  idleTimeoutMs: 30000, // 30s idle timeout
};
