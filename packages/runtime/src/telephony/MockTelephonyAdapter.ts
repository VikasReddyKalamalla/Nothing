import { EventEmitter } from 'events';
import { Buffer } from 'node:buffer';
import {
  AudioFrame,
  NormalizedTelephonyEvent,
  TelephonyCapabilities,
  MediaQueueConfig,
  DEFAULT_MEDIA_CONFIG,
} from './TelephonyTypes.js';
import { ITelephonyGatewayProvider, WebhookContext } from './ITelephonyProvider.js';
import { ITelephonyConnection } from './ITelephonyConnection.js';
import { MediaFrameCodec } from './MediaFrameCodec.js';
import { MediaStreamSession } from './MediaStreamSession.js';
import { TelephonyEventNormalizer } from './TelephonyEventNormalizer.js';
import { TelephonyError } from './TelephonyErrors.js';

export interface MockTelephonyGatewayOptions {
  autoRing?: boolean;
  autoAnswer?: boolean;
  ringDelayMs?: number;
  answerDelayMs?: number;
  mediaConfig?: Partial<MediaQueueConfig>;
}

export class MockTelephonyGatewayAdapter extends EventEmitter implements ITelephonyGatewayProvider {
  public readonly providerId = 'mock-telephony';
  public readonly capabilities: TelephonyCapabilities = {
    supportsBidiStreaming: true,
    supportedEncodings: ['pcm_16000', 'pcm_8000'],
    supportsBargeInFlush: true,
    maxFrameDurationMs: 20,
    maxFrameSizeBytes: 4096,
  };

  private readonly codec: MediaFrameCodec;
  private readonly mediaConfig: MediaQueueConfig;
  private readonly connections: Map<string, MediaStreamSession> = new Map();
  private isDisposed = false;

  constructor(private readonly options: MockTelephonyGatewayOptions = {}) {
    super();
    this.mediaConfig = { ...DEFAULT_MEDIA_CONFIG, ...options.mediaConfig };
    this.codec = new MediaFrameCodec(this.mediaConfig);
  }

  /**
   * Validate and normalize a webhook payload into a canonical NormalizedTelephonyEvent.
   */
  public normalizeWebhook(context: WebhookContext): NormalizedTelephonyEvent {
    let parsed: any;
    try {
      const text = context.rawBody.toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      throw new TelephonyError('Webhook body is not valid JSON', 'INVALID_JSON_WEBHOOK');
    }

    return TelephonyEventNormalizer.normalizeMockEvent(parsed, this.providerId);
  }

  /**
   * Parse a raw transport message (e.g. WebSocket frame) into an AudioFrame or NormalizedTelephonyEvent.
   */
  public parseMediaMessage(rawMessage: string | Buffer, callId: string): AudioFrame | NormalizedTelephonyEvent {
    const decoded = this.codec.decode(rawMessage, callId);
    return decoded.type === 'frame' ? decoded.frame : decoded.event;
  }

  /**
   * Encode an outgoing AudioFrame into mock transport JSON.
   */
  public encodeMediaMessage(frame: AudioFrame, streamId = 'mock-stream'): string {
    return this.codec.encodeAudio(frame, streamId);
  }

  /**
   * Encode a control frame (clear or stop).
   */
  public encodeControlMessage(
    type: 'clear' | 'stop',
    streamId = 'mock-stream',
    details?: Record<string, any>
  ): string {
    return this.codec.encodeControl(type, streamId, details);
  }

  /**
   * Create or bind a provider connection for an active call session.
   */
  public createConnection(callId: string, providerCallReference: string): ITelephonyConnection {
    if (this.isDisposed) {
      throw new TelephonyError('Provider adapter is disposed', 'PROVIDER_DISPOSED');
    }

    const session = new MediaStreamSession({
      callId,
      providerCallReference,
      config: this.mediaConfig,
    });

    this.connections.set(callId, session);

    session.on('close', () => {
      this.connections.delete(callId);
    });

    return session;
  }

  public getConnection(callId: string): MediaStreamSession | undefined {
    return this.connections.get(callId);
  }

  /**
   * Dispose all active connections and resources.
   */
  public async dispose(): Promise<void> {
    this.isDisposed = true;
    for (const session of this.connections.values()) {
      await session.close('PROVIDER_DISPOSED').catch(() => {});
    }
    this.connections.clear();
  }
}
