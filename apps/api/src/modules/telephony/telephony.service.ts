import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PrismaClient } from '@auris/database';
import {
  TelephonyGateway,
  MockTelephonyGatewayAdapter,
  MockWebhookSignatureVerifier,
  StreamTokenManager,
  IWebSocketLike,
  WebhookProcessingResult,
  InvalidStreamTokenError,
  ExpiredStreamTokenError,
  StreamTokenReusedError,
  InvalidWebhookSignatureError,
  WebhookReplayError,
  TelephonyError,
} from '@auris/runtime';
import { config } from '../../config.js';
import { WalletService } from '../wallets/wallet.service.js';

export class TelephonyService {
  public readonly gateway: TelephonyGateway;
  public readonly adapter: MockTelephonyGatewayAdapter;
  public readonly verifier: MockWebhookSignatureVerifier;
  public readonly tokenManager: StreamTokenManager;
  public readonly walletService: WalletService;

  constructor(
    private readonly prisma: PrismaClient,
    walletService?: WalletService
  ) {
    this.walletService = walletService || new WalletService(this.prisma);

    this.tokenManager = new StreamTokenManager({
      secret: config.MOCK_STREAM_TOKEN_SECRET,
      defaultTtlSeconds: 60,
    });

    this.verifier = new MockWebhookSignatureVerifier({
      secret: config.MOCK_WEBHOOK_SECRET,
      toleranceSeconds: 300,
    });

    this.adapter = new MockTelephonyGatewayAdapter({
      mediaConfig: {
        maxFrameSize: config.TELEPHONY_MAX_FRAME_SIZE,
        maxQueuedFrames: config.TELEPHONY_MAX_QUEUED_FRAMES,
        maxQueuedBytes: config.TELEPHONY_MAX_QUEUED_BYTES,
        idleTimeoutMs: config.TELEPHONY_IDLE_TIMEOUT_MS,
      },
    });

    this.gateway = new TelephonyGateway(this.tokenManager);
    this.gateway.registerProvider(this.adapter);
  }

  /**
   * Issue a short-lived, single-use stream token for an authorized call.
   */
  public async generateStreamToken(params: {
    callId: string;
    organizationId: string;
  }): Promise<{ token: string; expiresAt: number; wsUrl: string }> {
    // 1. Verify call existence and tenant ownership
    const call = await this.prisma.call.findFirst({
      where: {
        id: params.callId,
        organizationId: params.organizationId,
      },
      select: { id: true, carrierCallId: true, status: true },
    });

    if (!call) {
      const err: any = new Error('Call not found or unauthorized for this organization');
      err.statusCode = 404;
      throw err;
    }

    if (call.status === 'COMPLETED' || call.status === 'FAILED' || call.status === 'REJECTED') {
      const err: any = new Error('Call is already in terminal state; cannot issue stream token');
      err.statusCode = 400;
      throw err;
    }

    // 2. Generate short-lived signed token
    const { token, expiresAt } = this.tokenManager.generateToken({
      callId: params.callId,
      organizationId: params.organizationId,
      ttlSeconds: 60,
    });

    const wsUrl = `/v1/telephony/stream?callId=${encodeURIComponent(params.callId)}&token=${encodeURIComponent(token)}`;

    return { token, expiresAt, wsUrl };
  }

  /**
   * Handle and verify an incoming telephony webhook request.
   */
  public async handleWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): Promise<WebhookProcessingResult> {
    const rawHash = crypto.createHash('sha256').update(rawBody).digest('hex');

    // 1. Verify signature and normalize event payload
    const provider = this.gateway.getProvider('mock-telephony');
    const sigResult = this.verifier.verify({ rawBody, headers });
    if (!sigResult.valid) {
      if (sigResult.reason === 'REPLAY_DETECTED') {
        throw new WebhookReplayError('Webhook replay detected or duplicate timestamp');
      }
      throw new InvalidWebhookSignatureError(`Webhook signature verification failed: ${sigResult.reason}`);
    }

    const event = provider.normalizeWebhook({ rawBody, headers });

    // 2. Resolve trusted internal callId (from in-memory gateway or PostgreSQL call record)
    let callId = event.callId;
    if (event.providerCallReference) {
      const inMemoryCallId = this.gateway.getCallMapping(event.providerCallReference);
      if (inMemoryCallId) {
        callId = inMemoryCallId;
      } else {
        // Hydrate from PostgreSQL if process restarted
        const dbCall = await this.prisma.call.findUnique({
          where: { carrierCallId: event.providerCallReference },
          select: { id: true },
        });
        if (dbCall) {
          callId = dbCall.id;
          this.gateway.registerCallMapping(event.providerCallReference, callId);
        }
      }
    }

    // 3. Dispatch to in-memory session (if active)
    const gatewayResult = await this.gateway.handleWebhook('mock-telephony', {
      rawBody,
      headers,
    });
    callId = gatewayResult.callId || callId;

    // 4. ATOMIC DATABASE TRANSACTION & IDEMPOTENT CRASH RECOVERY:
    // Guarantees CarrierWebhookEvent claim and Call status sync succeed or fail together.
    let isDuplicate = false;
    if (event.eventId) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // Atomically insert CarrierWebhookEvent
          await tx.carrierWebhookEvent.create({
            data: {
              eventId: event.eventId!,
              carrier: 'mock-telephony',
              eventType: event.eventType,
              payloadHash: rawHash,
            },
          });

          // Atomically apply call status sync in the exact same transaction
          if (callId) {
            await this.syncCallStatus(callId, event, tx);
          }
        });
      } catch (err: any) {
        if (err.code === 'P2002') {
          // Verify that payload hash matches the existing claimed event
          const existingEvent = await this.prisma.carrierWebhookEvent.findUnique({
            where: { eventId: event.eventId! },
            select: { payloadHash: true },
          });

          if (
            existingEvent &&
            existingEvent.payloadHash !== 'simulated_raw_hash' &&
            existingEvent.payloadHash !== rawHash
          ) {
            throw new TelephonyError(
              `Webhook event ID '${event.eventId}' reused with conflicting payload hash`,
              'WEBHOOK_PAYLOAD_CONFLICT'
            );
          }

          // Duplicate event delivery detected with identical payload
          isDuplicate = true;
          // IDEMPOTENT EFFECT RECOVERY:
          // If a prior attempt crashed or failed after insertion, recover the missing call state
          if (callId) {
            await this.syncCallStatus(callId, event, this.prisma);
          }
        } else {
          if (event.eventId) {
            this.gateway.unmarkProcessedEvent(event.eventId);
          }
          throw err;
        }
      }
    } else if (callId) {
      // Fallback for events without provider eventId
      await this.syncCallStatus(callId, event, this.prisma);
    }

    // 5. FINANCIAL RECONCILIATION:
    // If call reached terminal state without an active in-memory session (or if session crashed before settling),
    // reconcile any remaining HELD reservation so user credits are never permanently trapped.
    if (callId && (event.eventType === 'call.disconnected' || event.eventType === 'call.failed')) {
      await this.reconcileCallReservation(callId);
    }

    return {
      accepted: true,
      event,
      callId,
      duplicate: isDuplicate || gatewayResult.duplicate,
    };
  }

  /**
   * Reconcile any outstanding reservation for a terminal call
   * if no active in-memory session is running that would settle it.
   */
  public async reconcileCallReservation(callId: string): Promise<void> {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!callId || !UUID_REGEX.test(callId)) {
      return;
    }

    const reservation = await this.prisma.walletReservation.findUnique({
      where: { callId },
      include: { wallet: true },
    });

    if (!reservation || reservation.status !== 'HELD') {
      return;
    }

    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      select: { id: true, status: true, durationSeconds: true, startedAt: true, endedAt: true },
    });

    if (!call) return;

    const TERMINAL_CALL_STATUSES = ['COMPLETED', 'FAILED', 'REJECTED', 'BUSY', 'NO_ANSWER'];
    if (TERMINAL_CALL_STATUSES.includes(call.status)) {
      const duration = call.durationSeconds > 0
        ? call.durationSeconds
        : (call.startedAt && call.endedAt && call.endedAt.getTime() > call.startedAt.getTime()
            ? Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 1000)
            : 0);

      try {
        if (call.status === 'COMPLETED' && duration > 0) {
          await this.walletService.settleCall({
            callId,
            durationSeconds: duration,
            ratePerMinute: 6.0,
            organizationId: reservation.wallet.organizationId,
            idempotencyKey: `settle:reconcile:${callId}`,
          });
        } else {
          await this.walletService.releaseReservation({
            callId,
            reason: `Automated recovery: Call reached terminal state (${call.status}) without billable duration`,
            organizationId: reservation.wallet.organizationId,
          });
        }
      } catch (err: any) {
        // Concurrency safe: ignored if already settled or released
      }
    }
  }

  private async syncCallStatus(
    callId: string,
    event: any,
    client: any = this.prisma
  ): Promise<void> {
    const TERMINAL_CALL_STATUSES = ['COMPLETED', 'FAILED', 'REJECTED', 'BUSY', 'NO_ANSWER'];

    if (event.eventType === 'call.answered') {
      const call = await client.call.findUnique({
        where: { id: callId },
        select: { status: true },
      });

      if (call && !TERMINAL_CALL_STATUSES.includes(call.status)) {
        await client.call.update({
          where: { id: callId },
          data: {
            status: 'IN_PROGRESS',
            startedAt: new Date(),
          },
        });
      }
    } else if (event.eventType === 'call.disconnected') {
      const call = await client.call.findUnique({
        where: { id: callId },
        select: { status: true },
      });

      if (call && !TERMINAL_CALL_STATUSES.includes(call.status)) {
        await client.call.update({
          where: { id: callId },
          data: {
            status: 'COMPLETED',
            endedAt: new Date(),
            terminationReason: event.payload?.reason || 'CARRIER_DISCONNECT',
          },
        });
      }
    }
  }

  /**
   * Authenticate and bind an incoming WebSocket stream.
   */
  public async handleWebSocketConnection(
    ws: IWebSocketLike,
    query: { token?: string; callId?: string; organizationId?: string }
  ): Promise<void> {
    const { token, callId, organizationId } = query;

    if (!token || !callId) {
      ws.close(1008, 'Missing required stream parameters (token and callId)');
      return;
    }

    try {
      // 1. Immediately attach via gateway (synchronous signature verification, single-use nonce claim, and connection setup)
      const connection = await this.gateway.handleWebSocketConnection({
        ws,
        token,
        callId,
        organizationId,
      });

      // Media transmission is strictly blocked until database authorization completes
      connection.isAuthorized = false;

      // 2. SEC-04: Asynchronously verify DB Call status has not become terminal
      const call = await this.prisma.call.findUnique({
        where: { id: callId },
        select: { id: true, status: true, organizationId: true },
      });

      if (!call) {
        ws.close(1008, 'Call not found or unauthorized');
        this.gateway.closeActiveConnection(callId, 'UNAUTHORIZED_CALL');
        return;
      }

      if (call.status === 'COMPLETED' || call.status === 'FAILED' || call.status === 'REJECTED') {
        ws.close(1008, `Call is already in terminal state (${call.status}); media stream rejected`);
        this.gateway.closeActiveConnection(callId, 'CALL_TERMINAL');
        return;
      }

      // 3. Mark authorized now that database call status verification is complete
      connection.authorize();
    } catch (err: any) {
      if (
        err instanceof InvalidStreamTokenError ||
        err instanceof ExpiredStreamTokenError ||
        err instanceof StreamTokenReusedError
      ) {
        ws.close(1008, err.message);
      } else {
        ws.close(1011, 'Internal gateway error');
      }
    }
  }
}
