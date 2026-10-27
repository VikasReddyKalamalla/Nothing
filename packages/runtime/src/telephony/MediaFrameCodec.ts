import { Buffer } from 'node:buffer';
import {
  AudioFrame,
  NormalizedTelephonyEvent,
  MediaQueueConfig,
  DEFAULT_MEDIA_CONFIG,
} from './TelephonyTypes.js';
import {
  MalformedMediaFrameError,
  UnsupportedAudioFormatError,
} from './TelephonyErrors.js';

export interface MockStartMessage {
  event: 'start';
  streamId: string;
  callReference: string;
  mediaFormat?: {
    encoding: string;
    sampleRate: number;
    channels: number;
  };
  customParameters?: {
    callId?: string;
    token?: string;
    organizationId?: string;
    [key: string]: any;
  };
}

export interface MockMediaMessage {
  event: 'media';
  streamId: string;
  sequenceNumber?: number;
  media: {
    payload: string; // Base64 PCM
    timestamp?: number;
  };
}

export interface MockClearMessage {
  event: 'clear';
  streamId: string;
}

export interface MockStopMessage {
  event: 'stop';
  streamId: string;
  reason?: string;
}

export interface MockErrorMessage {
  event: 'error';
  streamId: string;
  error: {
    code: string;
    message: string;
  };
}

export type MockProtocolMessage =
  | MockStartMessage
  | MockMediaMessage
  | MockClearMessage
  | MockStopMessage
  | MockErrorMessage;

export class MediaFrameCodec {
  private readonly config: MediaQueueConfig;
  private readonly base64Regex = /^[A-Za-z0-9+/=]+$/;

  constructor(config: Partial<MediaQueueConfig> = {}) {
    this.config = { ...DEFAULT_MEDIA_CONFIG, ...config };
  }

  /**
   * Decode a raw incoming WebSocket text or binary frame into an AudioFrame or NormalizedTelephonyEvent.
   */
  public decode(
    raw: string | Buffer,
    defaultCallId = ''
  ): { type: 'frame'; frame: AudioFrame } | { type: 'event'; event: NormalizedTelephonyEvent } {
    // 1. Enforce maximum message size
    const rawLen = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
    if (rawLen > this.config.maxMessageSize) {
      throw new MalformedMediaFrameError(
        `Incoming message size (${rawLen} bytes) exceeds maximum limit (${this.config.maxMessageSize} bytes)`
      );
    }

    // 2. Parse JSON
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new MalformedMediaFrameError('Malformed JSON message');
    }

    if (!msg || typeof msg !== 'object' || typeof msg.event !== 'string') {
      throw new MalformedMediaFrameError('Message missing required "event" string property');
    }

    const streamId = typeof msg.streamId === 'string' ? msg.streamId : 'unknown-stream';

    switch (msg.event) {
      case 'start': {
        const startMsg = msg as MockStartMessage;
        if (!startMsg.callReference) {
          throw new MalformedMediaFrameError('Start message missing callReference');
        }

        // Validate audio format if specified
        if (startMsg.mediaFormat) {
          const { encoding, sampleRate, channels } = startMsg.mediaFormat;
          if (encoding && encoding !== 'audio/x-l16' && encoding !== 'pcm_16000') {
            throw new UnsupportedAudioFormatError(`Unsupported audio encoding: ${encoding}`);
          }
          if (sampleRate && sampleRate !== 16000 && sampleRate !== 8000) {
            throw new UnsupportedAudioFormatError(`Unsupported sample rate: ${sampleRate}`);
          }
          if (channels && channels !== 1) {
            throw new UnsupportedAudioFormatError(`Unsupported channel count: ${channels}`);
          }
        }

        const callId = startMsg.customParameters?.callId || defaultCallId;
        const event: NormalizedTelephonyEvent = {
          eventId: `mock-evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          providerId: 'mock-telephony',
          eventType: 'media.started',
          providerCallReference: startMsg.callReference,
          callId,
          timestamp: Date.now(),
          payload: {
            streamId,
            mediaFormat: startMsg.mediaFormat || { encoding: 'audio/x-l16', sampleRate: 16000, channels: 1 },
            customParameters: startMsg.customParameters || {},
          },
        };
        return { type: 'event', event };
      }

      case 'media': {
        const mediaMsg = msg as MockMediaMessage;
        if (!mediaMsg.media || typeof mediaMsg.media.payload !== 'string') {
          throw new MalformedMediaFrameError('Media message missing media.payload');
        }

        const b64 = mediaMsg.media.payload.replace(/\s+/g, '');
        if (b64.length === 0) {
          throw new MalformedMediaFrameError('Media payload is empty');
        }

        if (!this.base64Regex.test(b64)) {
          throw new MalformedMediaFrameError('Invalid base64 characters in media payload');
        }

        let payloadBytes: Buffer;
        try {
          payloadBytes = Buffer.from(b64, 'base64');
        } catch {
          throw new MalformedMediaFrameError('Failed to decode base64 media payload');
        }

        if (payloadBytes.length > this.config.maxFrameSize) {
          throw new MalformedMediaFrameError(
            `Decoded audio frame (${payloadBytes.length} bytes) exceeds maxFrameSize (${this.config.maxFrameSize} bytes)`
          );
        }

        if (mediaMsg.sequenceNumber !== undefined) {
          if (!Number.isInteger(mediaMsg.sequenceNumber) || mediaMsg.sequenceNumber < 0) {
            throw new MalformedMediaFrameError('sequenceNumber must be a non-negative integer');
          }
        }

        const frame: AudioFrame = {
          callId: defaultCallId,
          payloadBytes,
          encoding: 'pcm_16000',
          sampleRate: 16000,
          channels: 1,
          sequenceNumber: mediaMsg.sequenceNumber,
          timestampMs: mediaMsg.media.timestamp,
        };
        return { type: 'frame', frame };
      }

      case 'clear': {
        const event: NormalizedTelephonyEvent = {
          eventId: `mock-evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          providerId: 'mock-telephony',
          eventType: 'media.error',
          providerCallReference: streamId,
          callId: defaultCallId,
          timestamp: Date.now(),
          payload: { action: 'clear', streamId },
        };
        return { type: 'event', event };
      }

      case 'stop': {
        const stopMsg = msg as MockStopMessage;
        const event: NormalizedTelephonyEvent = {
          eventId: `mock-evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          providerId: 'mock-telephony',
          eventType: 'media.stopped',
          providerCallReference: streamId,
          callId: defaultCallId,
          timestamp: Date.now(),
          payload: { reason: stopMsg.reason || 'NORMAL_CLOSE', streamId },
        };
        return { type: 'event', event };
      }

      case 'error': {
        const errorMsg = msg as MockErrorMessage;
        const event: NormalizedTelephonyEvent = {
          eventId: `mock-evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          providerId: 'mock-telephony',
          eventType: 'media.error',
          providerCallReference: streamId,
          callId: defaultCallId,
          timestamp: Date.now(),
          payload: {
            code: errorMsg.error?.code || 'MEDIA_ERROR',
            message: errorMsg.error?.message || 'Unknown media error',
            streamId,
          },
        };
        return { type: 'event', event };
      }

      default:
        throw new MalformedMediaFrameError(`Unsupported event type: ${(msg as any).event}`);
    }
  }

  /**
   * Encode an internal AudioFrame to a MockMediaMessage JSON string.
   */
  public encodeAudio(frame: AudioFrame, streamId: string, sequenceNumber?: number): string {
    if (frame.payloadBytes.length > this.config.maxFrameSize) {
      throw new MalformedMediaFrameError(
        `Audio frame size (${frame.payloadBytes.length} bytes) exceeds maxFrameSize (${this.config.maxFrameSize} bytes)`
      );
    }

    const payload = frame.payloadBytes.toString('base64');
    const msg: MockMediaMessage = {
      event: 'media',
      streamId,
      sequenceNumber,
      media: {
        payload,
        timestamp: frame.timestampMs ?? Date.now(),
      },
    };
    return JSON.stringify(msg);
  }

  /**
   * Encode a control frame (clear or stop).
   */
  public encodeControl(type: 'clear' | 'stop', streamId: string, details?: Record<string, any>): string {
    if (type === 'clear') {
      const msg: MockClearMessage = { event: 'clear', streamId };
      return JSON.stringify(msg);
    }
    const msg: MockStopMessage = { event: 'stop', streamId, reason: details?.reason };
    return JSON.stringify(msg);
  }
}
