import { EventEmitter } from 'events';
import { Buffer } from 'node:buffer';
import {
  AudioFrame,
  NormalizedTelephonyEvent,
  MediaQueueConfig,
  DEFAULT_MEDIA_CONFIG,
} from './TelephonyTypes.js';
import {
  QueueOverflowError,
  TelephonyError,
} from './TelephonyErrors.js';
import { MediaFrameCodec } from './MediaFrameCodec.js';
import { ITelephonyConnection } from './ITelephonyConnection.js';

export interface IWebSocketLike {
  send(data: string | Buffer, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: any, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  removeAllListeners?(event?: string): this;
  readyState: number;
}

export interface MediaStreamSessionOptions {
  callId: string;
  providerCallReference: string;
  streamId?: string;
  config?: Partial<MediaQueueConfig>;
}

export class MediaStreamSession extends EventEmitter implements ITelephonyConnection {
  public readonly callId: string;
  public readonly providerCallReference: string;
  public readonly streamId: string;
  public status: 'connecting' | 'open' | 'closed' = 'connecting';
  public isAuthorized = true;

  public authorize(): void {
    this.isAuthorized = true;
    this.emit('authorized', { streamId: this.streamId });
  }

  private readonly config: MediaQueueConfig;
  private readonly codec: MediaFrameCodec;
  private ws: IWebSocketLike | null = null;
  private readonly abortController = new AbortController();

  // Bounded Outbound Queue
  private outboundQueue: Array<{ data: string; bytes: number }> = [];
  private outboundQueuedBytes = 0;
  private isFlushingOutbound = false;

  // Bounded Inbound Queue / Rate Accounting
  private inboundQueuedBytes = 0;
  private inboundFramesCount = 0;

  private idleTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private outSeqNumber = 0;

  constructor(options: MediaStreamSessionOptions) {
    super();
    this.callId = options.callId;
    this.providerCallReference = options.providerCallReference;
    this.streamId = options.streamId || `str-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    this.config = { ...DEFAULT_MEDIA_CONFIG, ...options.config };
    this.codec = new MediaFrameCodec(this.config);
  }

  public attachWebSocket(ws: IWebSocketLike): void {
    if (this.isDisposed || this.status === 'closed') {
      ws.close(1008, 'Session already closed');
      return;
    }

    // Cleanly close and detach previous socket if one was already attached
    if (this.ws && this.ws !== ws) {
      try {
        this.ws.removeListener('message', this.onWsMessage);
        this.ws.removeListener('close', this.onWsClose);
        this.ws.removeListener('error', this.onWsError);
        this.ws.close(1000, 'SUPERSEDED_BY_NEW_CONNECTION');
      } catch {}
    }

    this.ws = ws;
    this.status = 'open';
    this.resetIdleTimer();

    this.onWsMessage = this.onWsMessage.bind(this);
    this.onWsClose = this.onWsClose.bind(this);
    this.onWsError = this.onWsError.bind(this);

    ws.on('message', this.onWsMessage);
    ws.on('close', this.onWsClose);
    ws.on('error', this.onWsError);

    this.emit('connected', { streamId: this.streamId });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.config.idleTimeoutMs <= 0 || this.status === 'closed') return;

    this.idleTimer = setTimeout(() => {
      this.handleIdleTimeout();
    }, this.config.idleTimeoutMs);
  }

  private handleIdleTimeout(): void {
    if (this.status !== 'open') return;
    this.emit('idleTimeout', { callId: this.callId, streamId: this.streamId });
    this.close('IDLE_TIMEOUT').catch(() => {});
  }

  private onWsMessage(raw: any, _isBinary: boolean): void {
    if (this.status !== 'open' || this.isDisposed || !this.isAuthorized) {
      // Reject media before authorization is complete or after terminal/closed state
      return;
    }

    this.resetIdleTimer();

    try {
      const decoded = this.codec.decode(raw, this.callId);
      if (decoded.type === 'frame') {
        const frame = decoded.frame;
        // Check inbound queue limits
        if (
          this.inboundFramesCount >= this.config.maxQueuedFrames ||
          this.inboundQueuedBytes + frame.payloadBytes.length > this.config.maxQueuedBytes
        ) {
          throw new QueueOverflowError(
            `Inbound queue limit exceeded (frames: ${this.inboundFramesCount}, bytes: ${this.inboundQueuedBytes})`
          );
        }

        this.inboundFramesCount++;
        this.inboundQueuedBytes += frame.payloadBytes.length;

        // Emit frame for STT processing
        this.emit('frame', frame);

        // Account for immediate consumption
        this.inboundFramesCount--;
        this.inboundQueuedBytes = Math.max(0, this.inboundQueuedBytes - frame.payloadBytes.length);
      } else {
        // Control / Lifecycle Event
        const event = decoded.event;
        if (event.eventType === 'media.stopped') {
          this.close('REMOTE_STOP').catch(() => {});
        } else if (event.payload?.action === 'clear') {
          this.clearBuffer().catch(() => {});
        }
        this.emit('event', event);
      }
    } catch (err: any) {
      this.emit('error', err);
      if (err instanceof QueueOverflowError) {
        this.close('QUEUE_OVERFLOW').catch(() => {});
      }
    }
  }

  private onWsClose(code: number, reason: string): void {
    this.status = 'closed';
    this.cleanup();
    this.emit('close', reason || `WS_CLOSE_${code}`);
  }

  private onWsError(err: Error): void {
    this.emit('error', err);
  }

  /**
   * Send an outgoing audio frame (from TTS) to the connected WebSocket.
   */
  public async sendAudioFrame(frame: AudioFrame): Promise<void> {
    if (this.status !== 'open' || !this.ws || this.isDisposed || !this.isAuthorized) {
      // Discard audio if connection is unauthorized, closed, or cancelling
      return;
    }

    this.outSeqNumber++;
    const encoded = this.codec.encodeAudio(frame, this.streamId, this.outSeqNumber);
    const bytes = Buffer.byteLength(encoded, 'utf8');

    const socketBufferedBytes = (this.ws as any)?.bufferedAmount || 0;
    const totalQueuedBytes = this.outboundQueuedBytes + socketBufferedBytes;

    // Enforce outbound queue bounds (accounting for in-memory queue + underlying socket buffer)
    if (
      this.outboundQueue.length >= this.config.maxQueuedFrames ||
      totalQueuedBytes + bytes > this.config.maxQueuedBytes
    ) {
      const err = new QueueOverflowError(
        `Outbound audio queue overflow (${this.outboundQueue.length} frames, ${totalQueuedBytes} buffered bytes)`
      );
      this.emit('error', err);
      throw err;
    }

    this.outboundQueue.push({ data: encoded, bytes });
    this.outboundQueuedBytes += bytes;

    this.drainOutboundQueue();
  }

  private drainOutboundQueue(): void {
    if (this.isFlushingOutbound || this.outboundQueue.length === 0 || !this.ws || this.status !== 'open') {
      return;
    }

    this.isFlushingOutbound = true;
    while (this.outboundQueue.length > 0 && this.status === 'open' && this.ws) {
      const item = this.outboundQueue.shift()!;
      this.outboundQueuedBytes = Math.max(0, this.outboundQueuedBytes - item.bytes);

      try {
        this.ws.send(item.data);
      } catch (err: any) {
        this.emit('error', err);
        break;
      }
    }
    this.isFlushingOutbound = false;
  }

  /**
   * Clear outbound queue immediately and send 'clear' control frame (Barge-in flush).
   */
  public async clearBuffer(): Promise<void> {
    // 1. Purge queued outbound audio frames
    this.outboundQueue = [];
    this.outboundQueuedBytes = 0;

    // 2. Transmit clear frame down the wire to carrier
    if (this.ws && this.status === 'open') {
      try {
        const clearMsg = this.codec.encodeControl('clear', this.streamId);
        this.ws.send(clearMsg);
      } catch {}
    }

    this.emit('bufferCleared', { streamId: this.streamId });
  }

  /**
   * Gracefully close the stream session.
   */
  public async close(reason = 'NORMAL_CLOSURE'): Promise<void> {
    if (this.status === 'closed' && this.isDisposed) {
      return;
    }

    this.status = 'closed';
    this.abortController.abort(reason);

    // Send stop frame if connected
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      try {
        const stopMsg = this.codec.encodeControl('stop', this.streamId, { reason });
        this.ws.send(stopMsg);
      } catch {}

      try {
        this.ws.close(1000, reason);
      } catch {}
    }

    this.cleanup();
    this.emit('close', reason);
  }

  public abort(err: Error): void {
    this.emit('error', err);
    this.close(`ABORT: ${err.message}`).catch(() => {});
  }

  private cleanup(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.outboundQueue = [];
    this.outboundQueuedBytes = 0;

    if (this.ws) {
      try {
        this.ws.removeListener('message', this.onWsMessage);
        this.ws.removeListener('close', this.onWsClose);
        this.ws.removeListener('error', this.onWsError);
      } catch {}
      this.ws = null;
    }
  }

  public getOutboundQueueStats(): { frames: number; bytes: number } {
    return {
      frames: this.outboundQueue.length,
      bytes: this.outboundQueuedBytes,
    };
  }
}
