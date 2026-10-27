import { EventEmitter } from 'events';
import { Buffer } from 'node:buffer';
import {
  ICarrierAdapter,
  CarrierCapabilities,
  OutboundCallRequest,
  CarrierCallResult,
  TerminateCarrierCallRequest,
  NormalizedCarrierEvent,
  NormalizedCarrierEventType,
  CarrierHealthResult,
} from './ICarrierAdapter.js';
import {
  AudioFrame,
  AudioEncoding,
  NormalizedTelephonyEvent,
  MediaQueueConfig,
  DEFAULT_MEDIA_CONFIG,
} from './TelephonyTypes.js';
import { ITelephonyGatewayProvider, WebhookContext } from './ITelephonyProvider.js';
import { ITelephonyConnection } from './ITelephonyConnection.js';
import { MediaStreamSession } from './MediaStreamSession.js';
import { MediaFrameCodec } from './MediaFrameCodec.js';
import { TelephonyEventNormalizer } from './TelephonyEventNormalizer.js';
import {
  CarrierAdapterError,
  CarrierInitiationFailedError,
  CarrierCallNotFoundError,
  InvalidCarrierEventError,
  TelephonyError,
} from './TelephonyErrors.js';
import { AudioCodec, G711MuLawCodec, PassThroughPCM16kCodec } from './AudioCodec.js';

export interface MockCarrierScenario {
  seed?: number;
  eventDelayMs?: number;
  duplicateEvents?: boolean;
  duplicateEventRate?: number;
  outOfOrderEvents?: boolean;
  droppedEventTypes?: NormalizedCarrierEventType[];
  forceInitiationFailure?: boolean;
  forceInitiationFailureReason?: string;
  forceAnswerTimeout?: boolean;
  temporaryUnavailability?: boolean;
  unavailabilityDurationMs?: number;
  codecType?: 'pcm_16000' | 'mulaw_8000';
  mediaConfig?: Partial<MediaQueueConfig>;
}

export interface InboundCallOfferParams {
  from?: string;
  to?: string;
  callId?: string;
  agentId?: string;
  organizationId?: string;
  metadata?: Record<string, unknown>;
}

export class MockCarrierSandbox extends EventEmitter implements ICarrierAdapter, ITelephonyGatewayProvider {
  public readonly id = 'mock-carrier-sandbox';
  public readonly providerId = 'mock-carrier-sandbox';

  public readonly capabilities: CarrierCapabilities = {
    supportsInbound: true,
    supportsOutbound: true,
    supportsBidiStreaming: true,
    supportsBargeInFlush: true,
    supportedEncodings: ['pcm_16000', 'pcm_8000', 'mulaw_8000'],
    maxFrameDurationMs: 20,
    maxFrameSizeBytes: 4096,
  };

  private scenario: MockCarrierScenario;
  private readonly mediaConfig: MediaQueueConfig;
  private readonly codec: MediaFrameCodec;
  private readonly audioCodec: AudioCodec;
  private readonly connections: Map<string, MediaStreamSession> = new Map();
  private readonly activeCalls: Map<string, {
    carrierCallId: string;
    internalCallId?: string;
    from: string;
    to: string;
    status: string;
    createdAt: number;
  }> = new Map();

  private readonly eventLog: NormalizedCarrierEvent[] = [];
  private readonly activeTimers: Set<NodeJS.Timeout> = new Set();
  private isDisposed = false;
  private sequenceCounter = 0;

  constructor(scenario: MockCarrierScenario = {}) {
    super();
    this.scenario = {
      eventDelayMs: 0,
      duplicateEvents: false,
      outOfOrderEvents: false,
      droppedEventTypes: [],
      forceInitiationFailure: false,
      codecType: 'pcm_16000',
      ...scenario,
    };

    this.mediaConfig = { ...DEFAULT_MEDIA_CONFIG, ...scenario.mediaConfig };
    this.codec = new MediaFrameCodec(this.mediaConfig);

    if (this.scenario.codecType === 'mulaw_8000') {
      this.audioCodec = new G711MuLawCodec();
    } else {
      this.audioCodec = new PassThroughPCM16kCodec();
    }
  }

  public updateScenario(scenario: Partial<MockCarrierScenario>): void {
    this.scenario = { ...this.scenario, ...scenario };
  }

  public getScenario(): Readonly<MockCarrierScenario> {
    return this.scenario;
  }

  public getEventLog(): ReadonlyArray<NormalizedCarrierEvent> {
    return [...this.eventLog];
  }

  public getActiveCallsCount(): number {
    return this.activeCalls.size;
  }

  public getAudioCodec(): AudioCodec {
    return this.audioCodec;
  }

  /**
   * Health and availability check.
   */
  public async getHealth(): Promise<CarrierHealthResult> {
    if (this.isDisposed) {
      return { healthy: false, details: { reason: 'DISPOSED' } };
    }
    if (this.scenario.temporaryUnavailability) {
      return {
        healthy: false,
        details: { reason: 'SIMULATED_TEMPORARY_UNAVAILABILITY' },
      };
    }
    return {
      healthy: true,
      latencyMs: 1,
      details: {
        activeCalls: this.activeCalls.size,
        activeConnections: this.connections.size,
        scenario: this.scenario,
      },
    };
  }

  /**
   * Initiate an outbound mock carrier call leg.
   */
  public async initiateOutboundCall(request: OutboundCallRequest): Promise<CarrierCallResult> {
    if (this.isDisposed) {
      throw new CarrierAdapterError('Carrier adapter is disposed', 'PROVIDER_DISPOSED');
    }

    if (this.scenario.temporaryUnavailability) {
      throw new CarrierAdapterError('Carrier service temporarily unavailable', 'CARRIER_UNAVAILABLE');
    }

    if (this.scenario.forceInitiationFailure) {
      const reason = this.scenario.forceInitiationFailureReason || 'MOCK_INITIATION_REJECTED';
      throw new CarrierInitiationFailedError(`Simulated carrier outbound initiation failure: ${reason}`);
    }

    // Validate phone number format (synthetic mock numbers permitted)
    if (!request.to || request.to.trim().length === 0) {
      throw new CarrierInitiationFailedError('Destination number cannot be empty');
    }

    const carrierCallId = `mock-carr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();

    this.activeCalls.set(carrierCallId, {
      carrierCallId,
      internalCallId: request.callId,
      from: request.from,
      to: request.to,
      status: 'initiated',
      createdAt: now,
    });

    const initiatedEvent = this.createNormalizedEvent({
      eventType: 'call.initiated',
      carrierCallId,
      callId: request.callId,
      payload: {
        from: request.from,
        to: request.to,
        direction: request.direction || 'OUTBOUND',
      },
    });

    this.dispatchLifecycleEvent(initiatedEvent);

    // Schedule ringing event if not dropped
    this.scheduleEvent(() => {
      if (!this.activeCalls.has(carrierCallId)) return;
      const ringingEvent = this.createNormalizedEvent({
        eventType: 'call.ringing',
        carrierCallId,
        callId: request.callId,
        payload: { carrierCallId },
      });
      this.dispatchLifecycleEvent(ringingEvent);
    }, this.scenario.eventDelayMs || 10);

    // Schedule answer event unless answer timeout is forced
    if (!this.scenario.forceAnswerTimeout) {
      this.scheduleEvent(() => {
        if (!this.activeCalls.has(carrierCallId)) return;
        const call = this.activeCalls.get(carrierCallId);
        if (call && call.status !== 'completed' && call.status !== 'failed') {
          call.status = 'connected';
          const answeredEvent = this.createNormalizedEvent({
            eventType: 'call.answered',
            carrierCallId,
            callId: request.callId,
            payload: { carrierCallId, answeredAt: Date.now() },
          });
          this.dispatchLifecycleEvent(answeredEvent);
        }
      }, (this.scenario.eventDelayMs || 10) + 30);
    }

    return {
      carrierCallId,
      status: 'initiated',
      providerId: this.id,
      timestamp: now,
    };
  }

  /**
   * Terminate or hang up a call.
   */
  public async terminateCall(request: TerminateCarrierCallRequest): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const call = this.activeCalls.get(request.carrierCallId);
    if (!call) {
      // Idempotent safe hangup
      return;
    }

    call.status = 'completed';
    this.activeCalls.delete(request.carrierCallId);

    const completedEvent = this.createNormalizedEvent({
      eventType: 'call.completed',
      carrierCallId: request.carrierCallId,
      callId: call.internalCallId,
      payload: { reason: request.reason || 'NORMAL_HANGUP', endedAt: Date.now() },
    });

    this.dispatchLifecycleEvent(completedEvent);

    // Close any attached media session
    if (call.internalCallId) {
      const conn = this.connections.get(call.internalCallId);
      if (conn) {
        this.connections.delete(call.internalCallId);
        await conn.close(request.reason || 'NORMAL_HANGUP').catch(() => {});
      }
    }
  }

  /**
   * Simulate an incoming call offered by the carrier network.
   */
  public simulateInboundCall(params: InboundCallOfferParams = {}): {
    carrierCallId: string;
    offerEvent: NormalizedCarrierEvent;
  } {
    if (this.isDisposed) {
      throw new CarrierAdapterError('Carrier adapter is disposed', 'PROVIDER_DISPOSED');
    }

    const carrierCallId = `mock-inbound-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const from = params.from || '+15550101';
    const to = params.to || '+15550199';

    this.activeCalls.set(carrierCallId, {
      carrierCallId,
      internalCallId: params.callId,
      from,
      to,
      status: 'offered',
      createdAt: Date.now(),
    });

    const offerEvent = this.createNormalizedEvent({
      eventType: 'call.offered',
      carrierCallId,
      callId: params.callId,
      payload: {
        from,
        to,
        agentId: params.agentId,
        organizationId: params.organizationId,
        direction: 'INBOUND',
        metadata: params.metadata || {},
      },
    });

    this.dispatchLifecycleEvent(offerEvent);

    return { carrierCallId, offerEvent };
  }

  /**
   * Simulate remote caller answering or completing call.
   */
  public simulateCallAnswer(carrierCallId: string): void {
    const call = this.activeCalls.get(carrierCallId);
    if (!call) throw new CarrierCallNotFoundError(`Carrier call ${carrierCallId} not found`);

    call.status = 'connected';
    const event = this.createNormalizedEvent({
      eventType: 'call.answered',
      carrierCallId,
      callId: call.internalCallId,
      payload: { answeredAt: Date.now() },
    });

    this.dispatchLifecycleEvent(event);
  }

  public simulateCallDisconnect(carrierCallId: string, reason = 'REMOTE_PARTY_DISCONNECT'): void {
    const call = this.activeCalls.get(carrierCallId);
    if (!call) return;

    call.status = 'completed';
    this.activeCalls.delete(carrierCallId);

    const event = this.createNormalizedEvent({
      eventType: 'call.completed',
      carrierCallId,
      callId: call.internalCallId,
      payload: { reason, endedAt: Date.now() },
    });

    this.dispatchLifecycleEvent(event);
  }

  /**
   * Normalize an untrusted raw payload or event into a canonical NormalizedCarrierEvent.
   */
  public normalizeEvent(input: unknown): NormalizedCarrierEvent {
    if (!input || typeof input !== 'object') {
      throw new InvalidCarrierEventError('Carrier event input must be a non-null object');
    }

    const raw = input as Record<string, any>;
    const carrierCallId = raw.carrierCallId || raw.callReference || raw.providerCallReference;
    if (!carrierCallId || typeof carrierCallId !== 'string') {
      throw new InvalidCarrierEventError('Carrier event missing valid carrierCallId');
    }

    const rawType = (raw.eventType || raw.event || '').toLowerCase();
    let eventType: NormalizedCarrierEventType;

    switch (rawType) {
      case 'offered':
      case 'call.offered':
        eventType = 'call.offered';
        break;
      case 'initiated':
      case 'call.initiated':
        eventType = 'call.initiated';
        break;
      case 'ringing':
      case 'call.ringing':
        eventType = 'call.ringing';
        break;
      case 'answered':
      case 'connected':
      case 'call.answered':
        eventType = 'call.answered';
        break;
      case 'media.requested':
        eventType = 'media.requested';
        break;
      case 'media.connected':
        eventType = 'media.connected';
        break;
      case 'media.disconnected':
        eventType = 'media.disconnected';
        break;
      case 'completed':
      case 'disconnected':
      case 'ended':
      case 'call.completed':
      case 'call.disconnected':
        eventType = 'call.completed';
        break;
      case 'failed':
      case 'call.failed':
        eventType = 'call.failed';
        break;
      case 'rejected':
      case 'call.rejected':
        eventType = 'call.rejected';
        break;
      case 'busy':
      case 'call.busy':
        eventType = 'call.busy';
        break;
      case 'unanswered':
      case 'no_answer':
      case 'call.unanswered':
        eventType = 'call.unanswered';
        break;
      case 'cancelled':
      case 'call.cancelled':
        eventType = 'call.cancelled';
        break;
      case 'transport.error':
      case 'media.error':
        eventType = 'transport.error';
        break;
      default:
        throw new InvalidCarrierEventError(`Unsupported carrier event type: "${rawType}"`);
    }

    let timestamp = Date.now();
    if (typeof raw.timestamp === 'number' && !isNaN(raw.timestamp)) {
      timestamp = raw.timestamp;
    } else if (typeof raw.timestamp === 'string') {
      const parsed = Date.parse(raw.timestamp);
      timestamp = isNaN(parsed) ? Date.now() : parsed;
    }

    const eventId = raw.eventId || raw.id || `evt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    return {
      eventId,
      providerEventId: raw.eventId || raw.id,
      providerId: this.id,
      eventType,
      carrierCallId,
      callId: raw.callId,
      timestamp,
      payload: (raw.payload && typeof raw.payload === 'object') ? raw.payload : { ...raw },
      correlationId: raw.correlationId,
      sequenceNumber: typeof raw.sequenceNumber === 'number' ? raw.sequenceNumber : undefined,
      payloadFingerprint: raw.payloadFingerprint,
    };
  }

  // --- ITelephonyGatewayProvider compatibility bridge ---

  public normalizeWebhook(context: WebhookContext): NormalizedTelephonyEvent {
    let parsed: any;
    try {
      const text = context.rawBody.toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      throw new TelephonyError('Webhook body is not valid JSON', 'INVALID_JSON_WEBHOOK');
    }

    const normalizedCarrier = this.normalizeEvent(parsed);

    // Map NormalizedCarrierEvent to NormalizedTelephonyEvent for existing gateway
    let gatewayType: any = 'call.initiated';
    if (normalizedCarrier.eventType === 'call.ringing') gatewayType = 'call.ringing';
    else if (normalizedCarrier.eventType === 'call.answered') gatewayType = 'call.answered';
    else if (normalizedCarrier.eventType === 'call.completed') gatewayType = 'call.disconnected';
    else if (normalizedCarrier.eventType === 'call.failed') gatewayType = 'call.failed';
    else if (normalizedCarrier.eventType === 'transport.error') gatewayType = 'media.error';

    return {
      eventId: normalizedCarrier.eventId,
      providerEventId: normalizedCarrier.providerEventId,
      providerId: this.providerId,
      eventType: gatewayType,
      providerCallReference: normalizedCarrier.carrierCallId,
      callId: normalizedCarrier.callId,
      timestamp: normalizedCarrier.timestamp,
      payload: normalizedCarrier.payload,
    };
  }

  public parseMediaMessage(rawMessage: string | Buffer, callId: string): AudioFrame | NormalizedTelephonyEvent {
    const decoded = this.codec.decode(rawMessage, callId);
    return decoded.type === 'frame' ? decoded.frame : decoded.event;
  }

  public encodeMediaMessage(frame: AudioFrame, streamId = 'mock-stream'): string {
    return this.codec.encodeAudio(frame, streamId);
  }

  public encodeControlMessage(
    type: 'clear' | 'stop',
    streamId = 'mock-stream',
    details?: Record<string, any>
  ): string {
    return this.codec.encodeControl(type, streamId, details);
  }

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

  // --- Internal helpers ---

  private createNormalizedEvent(params: {
    eventType: NormalizedCarrierEventType;
    carrierCallId: string;
    callId?: string;
    payload?: Record<string, unknown>;
  }): NormalizedCarrierEvent {
    this.sequenceCounter++;
    return {
      eventId: `evt-${Date.now()}-${this.sequenceCounter}-${Math.random().toString(36).substring(2, 6)}`,
      providerEventId: `p-evt-${this.sequenceCounter}`,
      providerId: this.id,
      eventType: params.eventType,
      carrierCallId: params.carrierCallId,
      callId: params.callId,
      timestamp: Date.now(),
      payload: params.payload || {},
      sequenceNumber: this.sequenceCounter,
    };
  }

  private dispatchLifecycleEvent(event: NormalizedCarrierEvent): void {
    if (this.scenario.droppedEventTypes?.includes(event.eventType)) {
      return; // Fault injection: dropped event
    }

    this.eventLog.push(event);

    const emitEvent = () => {
      this.emit('carrierEvent', event);
      this.emit(event.eventType, event);

      // Fault injection: duplicate event
      if (this.scenario.duplicateEvents) {
        this.emit('carrierEvent', { ...event, isDuplicate: true });
        this.emit(event.eventType, { ...event, isDuplicate: true });
      }
    };

    if (this.scenario.eventDelayMs && this.scenario.eventDelayMs > 0) {
      this.scheduleEvent(emitEvent, this.scenario.eventDelayMs);
    } else {
      emitEvent();
    }
  }

  private scheduleEvent(fn: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.activeTimers.delete(timer);
      if (!this.isDisposed) {
        fn();
      }
    }, delayMs);
    this.activeTimers.add(timer);
  }

  /**
   * Safe disposal of all active calls, connections, timers, and listeners.
   */
  public async dispose(): Promise<void> {
    this.isDisposed = true;

    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();

    for (const session of this.connections.values()) {
      await session.close('PROVIDER_DISPOSED').catch(() => {});
    }
    this.connections.clear();
    this.activeCalls.clear();
    this.removeAllListeners();
  }
}
