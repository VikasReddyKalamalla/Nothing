import { EventEmitter } from 'events';
import { Buffer } from 'node:buffer';
import {
  NormalizedTelephonyEvent,
  TelephonyEventType,
  AudioFrame,
} from './TelephonyTypes.js';
import { ITelephonyGatewayProvider, WebhookContext } from './ITelephonyProvider.js';
import { IWebhookSignatureVerifier } from './WebhookSignatureVerifier.js';
import { StreamTokenManager } from './StreamTokenManager.js';
import { MediaStreamSession, IWebSocketLike } from './MediaStreamSession.js';
import {
  InvalidWebhookSignatureError,
  WebhookReplayError,
  UnauthenticatedStreamError,
  TelephonyError,
} from './TelephonyErrors.js';
import { CallSession } from '../session/CallSession.js';

export interface TelephonyGatewayConfig {
  defaultProviderId?: string;
}

export interface WebhookProcessingResult {
  accepted: boolean;
  event: NormalizedTelephonyEvent;
  callId?: string;
  duplicate?: boolean;
}

export class TelephonyGateway extends EventEmitter {
  private readonly providers: Map<string, ITelephonyGatewayProvider> = new Map();
  private readonly verifiers: Map<string, IWebhookSignatureVerifier> = new Map();
  private readonly streamTokenManager: StreamTokenManager;

  // Trusted internal mappings: providerCallReference -> callId
  private readonly providerCallMap: Map<string, string> = new Map();

  // Active Call Sessions: callId -> CallSession
  private readonly activeSessions: Map<string, CallSession> = new Map();

  // Active Media Connections: callId -> MediaStreamSession
  private readonly activeConnections: Map<string, MediaStreamSession> = new Map();

  // Processed event deduplication cache: eventId -> timestamp
  private readonly processedEvents: Map<string, number> = new Map();

  constructor(
    streamTokenManager: StreamTokenManager,
    private readonly config: TelephonyGatewayConfig = {}
  ) {
    super();
    this.streamTokenManager = streamTokenManager;
  }

  public registerProvider(provider: ITelephonyGatewayProvider, verifier?: IWebhookSignatureVerifier): void {
    this.providers.set(provider.providerId, provider);
    if (verifier) {
      this.verifiers.set(provider.providerId, verifier);
    }
  }

  public getProvider(providerId?: string): ITelephonyGatewayProvider {
    const id = providerId || this.config.defaultProviderId || 'mock-telephony';
    const provider = this.providers.get(id);
    if (!provider) {
      throw new TelephonyError(`Telephony provider "${id}" not registered`, 'UNKNOWN_PROVIDER');
    }
    return provider;
  }

  /**
   * Register a trusted mapping between a carrier call reference and an internal callId.
   */
  public registerCallMapping(providerCallReference: string, callId: string): void {
    this.providerCallMap.set(providerCallReference, callId);
  }

  public getCallMapping(providerCallReference: string): string | undefined {
    return this.providerCallMap.get(providerCallReference);
  }

  /**
   * Unregister call mapping when call terminates.
   */
  public unregisterCallMapping(providerCallReference: string): void {
    this.providerCallMap.delete(providerCallReference);
  }

  public unmarkProcessedEvent(eventId: string): void {
    this.processedEvents.delete(eventId);
  }

  /**
   * Register an active CallSession with the gateway for real-time media routing.
   */
  public registerSession(session: CallSession, providerCallReference?: string): void {
    const callId = session.config.callId;
    this.activeSessions.set(callId, session);

    const ref = providerCallReference || session.getCarrierCallId();
    if (ref) {
      this.registerCallMapping(ref, callId);
    }

    session.once('callEnded', () => {
      this.cleanupSession(callId, ref);
    });
  }

  /**
   * Process and verify an incoming webhook request.
   */
  public async handleWebhook(
    providerId: string,
    context: WebhookContext
  ): Promise<WebhookProcessingResult> {
    const provider = this.getProvider(providerId);
    const verifier = this.verifiers.get(providerId);

    // 1. Webhook Signature Verification
    if (verifier) {
      const result = verifier.verify({
        rawBody: context.rawBody,
        headers: context.headers,
      });

      if (!result.valid) {
        if (result.reason === 'REPLAY_DETECTED') {
          throw new WebhookReplayError('Webhook replay detected or duplicate timestamp');
        }
        throw new InvalidWebhookSignatureError(`Webhook signature verification failed: ${result.reason}`);
      }
    }

    // 2. Normalize Event
    const normalized = provider.normalizeWebhook(context);

    // 3. Resolve and Validate Trusted Internal Call ID
    const trustedCallId = normalized.providerCallReference
      ? this.providerCallMap.get(normalized.providerCallReference)
      : undefined;

    if (normalized.callId && trustedCallId && normalized.callId !== trustedCallId) {
      throw new TelephonyError(
        `Cross-tenant call ID mismatch: payload callId "${normalized.callId}" does not match trusted mapping "${trustedCallId}"`,
        'CROSS_TENANT_CALL_MISMATCH'
      );
    }

    const callId = trustedCallId || normalized.callId;

    // 4. In-Memory Event Idempotency Check
    if (normalized.eventId && this.processedEvents.has(normalized.eventId)) {
      return {
        accepted: true,
        event: normalized,
        callId,
        duplicate: true,
      };
    }

    // 5. Route to Active Call Session if registered
    if (callId && this.activeSessions.has(callId)) {
      const session = this.activeSessions.get(callId)!;
      await this.applyLifecycleEventToSession(session, normalized);
    }

    // Record in in-memory processedEvents cache ONLY after successful session lifecycle dispatch
    if (normalized.eventId) {
      this.processedEvents.set(normalized.eventId, Date.now());
      if (this.processedEvents.size > 10_000) {
        const cutoff = Date.now() - 3600_000; // 1 hour
        for (const [id, ts] of this.processedEvents.entries()) {
          if (ts < cutoff) this.processedEvents.delete(id);
        }
      }
    }

    this.emit('webhookEvent', normalized);

    return {
      accepted: true,
      event: normalized,
      callId,
      duplicate: false,
    };
  }

  private async applyLifecycleEventToSession(
    session: CallSession,
    event: NormalizedTelephonyEvent
  ): Promise<void> {
    if (session.isTerminal()) {
      // Late events must not revive a terminal call
      return;
    }

    switch (event.eventType) {
      case 'call.ringing':
        session.emit('ringing', { carrierCallId: event.providerCallReference });
        break;

      case 'call.answered':
        if (session.getState() === 'RINGING' as any) {
          await session.handleCallConnected();
        }
        break;

      case 'call.disconnected':
        await session.terminate(event.payload.reason || 'CARRIER_DISCONNECT', false);
        break;

      case 'call.failed':
        await session.terminate(event.payload.reason || 'CARRIER_FAILURE', true);
        break;
    }
  }

  /**
   * Authenticate and attach an incoming WebSocket stream to an active call session.
   */
  public async handleWebSocketConnection(params: {
    ws: IWebSocketLike;
    token: string;
    callId: string;
    organizationId?: string;
  }): Promise<MediaStreamSession> {
    const { ws, token, callId, organizationId } = params;

    // 1. Authenticate Stream Token (checks signature, expiry, purpose, and single-use claim)
    try {
      this.streamTokenManager.verifyAndClaimToken(token, callId, organizationId);
    } catch (err: any) {
      ws.close(1008, err.message || 'Stream authentication failed');
      throw new UnauthenticatedStreamError(`Stream token rejected: ${err.message}`);
    }

    // 2. Resolve or create MediaStreamSession
    let connection = this.activeConnections.get(callId);
    if (!connection) {
      const provider = this.getProvider();
      connection = provider.createConnection(callId, `carrier-${callId}`) as MediaStreamSession;
      this.activeConnections.set(callId, connection);
    }

    connection.attachWebSocket(ws);

    // 3. Connect to CallSession if registered
    const session = this.activeSessions.get(callId);
    if (session) {
      this.bindSessionMedia(session, connection);
    }

    this.emit('streamAttached', { callId, streamId: connection.streamId });

    return connection;
  }

  /**
   * Bind bidirectional audio between CallSession and MediaStreamSession.
   */
  private bindSessionMedia(session: CallSession, connection: MediaStreamSession): void {
    // Forward inbound audio from WebSocket connection into CallSession's STT stream
    const onFrame = (frame: AudioFrame) => {
      const sttStream = session.getSTTStream();
      if (sttStream) {
        sttStream.pushAudio(frame.payloadBytes);
      }
    };

    connection.on('frame', onFrame);

    // Forward barge-in clear events from Orchestrator into WebSocket connection
    const orchestrator = session.getOrchestrator();
    if (orchestrator) {
      orchestrator.on('bargeIn', () => {
        connection.clearBuffer().catch(() => {});
      });
    }

    // Clean up when connection closes
    connection.once('close', (reason) => {
      connection.removeListener('frame', onFrame);
      if (!session.isTerminal()) {
        session.terminate(`WEBSOCKET_CLOSED: ${reason}`, false).catch(() => {});
      }
    });
  }

  public getActiveConnection(callId: string): MediaStreamSession | undefined {
    return this.activeConnections.get(callId);
  }

  public closeActiveConnection(callId: string, reason = 'CALL_ENDED'): void {
    const connection = this.activeConnections.get(callId);
    if (connection) {
      this.activeConnections.delete(callId);
      connection.close(reason).catch(() => {});
    }
  }

  public getActiveSession(callId: string): CallSession | undefined {
    return this.activeSessions.get(callId);
  }

  private cleanupSession(callId: string, providerCallReference?: string | null): void {
    this.activeSessions.delete(callId);
    if (providerCallReference) {
      this.providerCallMap.delete(providerCallReference);
    }

    const connection = this.activeConnections.get(callId);
    if (connection) {
      this.activeConnections.delete(callId);
      connection.close('CALL_ENDED').catch(() => {});
    }
  }

  public async dispose(): Promise<void> {
    for (const [callId, conn] of this.activeConnections.entries()) {
      await conn.close('GATEWAY_SHUTDOWN').catch(() => {});
    }
    this.activeConnections.clear();
    this.activeSessions.clear();
    this.providerCallMap.clear();
    this.processedEvents.clear();
  }
}
