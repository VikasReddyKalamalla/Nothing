import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@auris/database';
import {
  InvalidWebhookSignatureError,
  WebhookReplayError,
  TelephonyError,
} from '@auris/runtime';
import { TelephonyService } from './telephony.service.js';

export let activeTelephonyService: TelephonyService | null = null;

export async function telephonyRoutes(app: FastifyInstance) {
  const telephonyService = new TelephonyService(prisma);
  activeTelephonyService = telephonyService;

  // Expose service on fastify instance for testing/lifecycle inspection
  (app as any).telephonyService = telephonyService;

  /**
   * Carrier/Mock Telephony Webhook Endpoint
   * Validates canonical raw-body HMAC-SHA256 signature and applies lifecycle transitions.
   */
  app.post(
    '/webhook',
    {
      schema: {
        description: 'Mock telephony webhook receiver for normalized call events',
        tags: ['Telephony'],
        response: {
          200: z.object({
            success: z.boolean(),
            accepted: z.boolean(),
            eventId: z.string(),
            eventType: z.string(),
            duplicate: z.boolean().optional(),
          }),
          400: z.object({
            error: z.string(),
            message: z.string(),
          }),
          401: z.object({
            error: z.string(),
            message: z.string(),
          }),
          409: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (req, reply) => {
      const rawBody = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));

      try {
        const result = await telephonyService.handleWebhook(rawBody, req.headers);

        return reply.status(200).send({
          success: true,
          accepted: result.accepted,
          eventId: result.event.eventId,
          eventType: result.event.eventType,
          duplicate: result.duplicate,
        });
      } catch (err: any) {
        if (err instanceof InvalidWebhookSignatureError) {
          return reply.status(401).send({
            error: 'UNAUTHORIZED',
            message: 'Webhook signature verification failed',
          });
        }
        if (err instanceof WebhookReplayError) {
          return reply.status(409).send({
            error: 'REPLAY_DETECTED',
            message: 'Webhook request detected as replay or timestamp out of tolerance',
          });
        }
        if (err instanceof TelephonyError) {
          const statusCode = err.code === 'WEBHOOK_PAYLOAD_CONFLICT' ? 409 : 400;
          return reply.status(statusCode).send({
            error: err.code || 'BAD_REQUEST',
            message: err.message,
          });
        }
        throw err;
      }
    }
  );

  /**
   * Stream Token Generation Endpoint (Authenticated)
   * Generates a single-purpose, short-lived signed token bound to an authorized callId.
   */
  app.post(
    '/stream-token',
    {
      schema: {
        description: 'Generate single-purpose signed media stream token for an authorized call',
        tags: ['Telephony'],
        body: z.object({
          callId: z.string().uuid(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            token: z.string(),
            expiresAt: z.number(),
            wsUrl: z.string(),
          }),
          400: z.object({
            error: z.string(),
            message: z.string(),
          }),
          403: z.object({
            error: z.string(),
            message: z.string(),
          }),
          404: z.object({
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (req, reply) => {
      await req.jwtVerify();
      const user = req.user as { userId: string };

      const { callId } = req.body as { callId: string };

      // Verify user's membership and organization ownership of the call
      const membership = await prisma.membership.findFirst({
        where: { userId: user.userId },
        select: { organizationId: true },
      });

      if (!membership) {
        return reply.status(403).send({
          error: 'FORBIDDEN',
          message: 'User does not belong to any active organization',
        });
      }

      const result = await telephonyService.generateStreamToken({
        callId,
        organizationId: membership.organizationId,
      });

      return reply.status(200).send({
        success: true,
        token: result.token,
        expiresAt: result.expiresAt,
        wsUrl: result.wsUrl,
      });
    }
  );

  /**
   * WebSocket Media Streaming Endpoint
   * Bidirectional real-time audio gateway for Auris Voice Runtime.
   */
  app.get(
    '/stream',
    { websocket: true },
    (socket, req) => {
      const query = (req.query || {}) as {
        token?: string;
        callId?: string;
        organizationId?: string;
      };

      telephonyService.handleWebSocketConnection(socket as any, query);
    }
  );
}
