import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@auris/database';
import { WalletService } from './wallet.service.js';
import { requireAuth, requireRole, enforceTenantIsolation } from '../auth/rbac.middleware.js';
import { MockTelephonyAdapter } from '../telephony/mock-telephony.adapter.js';
import { config } from '../../config.js';

export const walletRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const walletService = new WalletService(prisma);
  const telephonyAdapter = new MockTelephonyAdapter();

  // Get Wallet Balance
  app.get(
    '/:orgId/balance',
    {
      preHandler: [requireAuth(), enforceTenantIsolation('orgId')],
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const balance = await walletService.getWalletBalance(orgId);
      return reply.send(balance);
    }
  );

  // Top Up Wallet
  app.post(
    '/:orgId/topup',
    {
      preHandler: [requireAuth(), enforceTenantIsolation('orgId'), requireRole(Role.OWNER, Role.ADMIN)],
      schema: {
        body: z.object({
          amountCredits: z.number().positive(),
          idempotencyKey: z.string().min(8),
          description: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const { amountCredits, idempotencyKey, description } = request.body as {
        amountCredits: number;
        idempotencyKey: string;
        description?: string;
      };

      const result = await walletService.topUpWallet({
        organizationId: orgId,
        amountCredits,
        idempotencyKey,
        description,
      });

      return reply.status(200).send(result);
    }
  );

  // Create Pre-Call Hold
  app.post(
    '/:orgId/reservations',
    {
      preHandler: [requireAuth(), enforceTenantIsolation('orgId'), requireRole(Role.OWNER, Role.ADMIN)],
      schema: {
        body: z.object({
          callId: z.string().min(1),
          amountCredits: z.number().positive(),
          idempotencyKey: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const { callId, amountCredits, idempotencyKey } = request.body as {
        callId: string;
        amountCredits: number;
        idempotencyKey?: string;
      };

      try {
        const reservation = await walletService.createReservation({
          organizationId: orgId,
          callId,
          amountCredits,
          idempotencyKey,
        });

        return reply.status(201).send(reservation);
      } catch (err: any) {
        if (err.message === 'INSUFFICIENT_FUNDS') {
          return reply.status(402).send({
            error: 'INSUFFICIENT_FUNDS',
            message: 'Wallet balance is insufficient to reserve funds for this call',
          });
        }
        throw err;
      }
    }
  );

  // Extend Pre-Call Hold Mid-Call (Overdraft Prevention & Call Continuation)
  app.post(
    '/reservations/extend',
    {
      preHandler: [requireAuth()],
      schema: {
        body: z.object({
          callId: z.string().min(1),
          additionalCredits: z.number().positive(),
          idempotencyKey: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { callId, additionalCredits, idempotencyKey } = request.body as {
        callId: string;
        additionalCredits: number;
        idempotencyKey?: string;
      };

      try {
        const result = await walletService.extendReservation({
          callId,
          additionalCredits,
          idempotencyKey,
          organizationId: request.userPayload!.organizationId,
        });

        if (result.action === 'TERMINATE_CALL') {
          return reply.status(402).send({
            error: 'INSUFFICIENT_FUNDS_FOR_EXTENSION',
            message: 'Wallet balance is insufficient to extend hold; call must be terminated.',
            ...result,
          });
        }

        return reply.status(200).send(result);
      } catch (err: any) {
        if (err.message === 'CROSS_TENANT_ACCESS_DENIED') {
          return reply.status(403).send({
            error: 'CROSS_TENANT_ACCESS_DENIED',
            message: 'Access to reservations belonging to another organization is strictly forbidden',
          });
        }
        if (err.message === 'RESERVATION_NOT_FOUND') {
          return reply.status(404).send({
            error: 'RESERVATION_NOT_FOUND',
            message: 'Call reservation not found',
          });
        }
        if (err.message === 'CANNOT_EXTEND_NON_HELD_RESERVATION') {
          return reply.status(400).send({
            error: 'CANNOT_EXTEND_NON_HELD_RESERVATION',
            message: 'Only active (HELD) reservations can be extended',
          });
        }
        throw err;
      }
    }
  );

  // Reconcile Expired Reservations (Automated Worker or Admin Trigger)
  app.post(
    '/reconcile-expired',
    {
      preHandler: async (request, reply) => {
        const internalSecret = request.headers['x-auris-internal-secret'] as string | undefined;
        if (internalSecret && internalSecret === config.JWT_SECRET) {
          return;
        }
        await requireAuth()(request, reply);
        if (reply.sent) return;
        await requireRole(Role.OWNER, Role.ADMIN)(request, reply);
      },
    },
    async (request, reply) => {
      const results = await walletService.reconcileExpiredReservations(new Date());
      return reply.status(200).send({
        reconciledCount: results.length,
        reconciled: results,
      });
    }
  );

  // Settle Call (Tenant-Scoped / Authenticated User Path)
  app.post(
    '/settle',
    {
      preHandler: [requireAuth()],
      schema: {
        body: z.object({
          callId: z.string().min(1),
          durationSeconds: z.number().int().nonnegative(),
          ratePerMinute: z.number().positive(),
          billingBlockSeconds: z.number().int().positive().default(30),
          idempotencyKey: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        callId: string;
        durationSeconds: number;
        ratePerMinute: number;
        billingBlockSeconds?: number;
        idempotencyKey?: string;
      };

      try {
        // Enforce that authenticated user can ONLY settle reservations owned by their organization
        const result = await walletService.settleCall({
          ...body,
          organizationId: request.userPayload!.organizationId,
        });
        return reply.status(200).send(result);
      } catch (err: any) {
        if (err.message === 'CROSS_TENANT_ACCESS_DENIED') {
          return reply.status(403).send({
            error: 'CROSS_TENANT_ACCESS_DENIED',
            message: 'Access to reservations belonging to another organization is strictly forbidden',
          });
        }
        if (err.message === 'RESERVATION_NOT_FOUND') {
          return reply.status(404).send({
            error: 'RESERVATION_NOT_FOUND',
            message: 'Call reservation not found',
          });
        }
        throw err;
      }
    }
  );

  // Release Hold (Tenant-Scoped / Authenticated User Path)
  app.post(
    '/release',
    {
      preHandler: [requireAuth()],
      schema: {
        body: z.object({
          callId: z.string().min(1),
          reason: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { callId, reason } = request.body as { callId: string; reason?: string };

      try {
        // Enforce that authenticated user can ONLY release reservations owned by their organization
        const result = await walletService.releaseReservation({
          callId,
          reason,
          organizationId: request.userPayload!.organizationId,
        });
        return reply.status(200).send(result);
      } catch (err: any) {
        if (err.message === 'CROSS_TENANT_ACCESS_DENIED') {
          return reply.status(403).send({
            error: 'CROSS_TENANT_ACCESS_DENIED',
            message: 'Access to reservations belonging to another organization is strictly forbidden',
          });
        }
        if (err.message === 'RESERVATION_NOT_FOUND') {
          return reply.status(404).send({
            error: 'RESERVATION_NOT_FOUND',
            message: 'Call reservation not found',
          });
        }
        throw err;
      }
    }
  );

  // Dedicated Carrier / Voice Runtime Webhook Callback Path
  app.post(
    '/webhooks/carrier',
    {
      schema: {
        body: z.object({
          carrierCallId: z.string().min(1),
          callId: z.string().min(1),
          eventType: z.enum(['call.completed', 'call.failed', 'call.busy', 'call.no_answer']),
          durationSeconds: z.number().int().nonnegative().optional(),
          ratePerMinute: z.number().positive().optional(),
          billingBlockSeconds: z.number().int().positive().default(30),
        }),
      },
    },
    async (request, reply) => {
      const signature = (request.headers['x-auris-signature'] || request.headers['x-telephony-signature']) as string | undefined;
      const internalSecret = request.headers['x-auris-internal-secret'] as string | undefined;

      // Verify either cryptographic webhook signature or internal trusted worker secret
      const rawPayload = JSON.stringify(request.body);
      const isSignatureValid = signature ? telephonyAdapter.verifyWebhookSignature(signature, rawPayload) : false;
      const isSecretValid = internalSecret === config.JWT_SECRET;

      if (!isSignatureValid && !isSecretValid) {
        return reply.status(401).send({
          error: 'INVALID_CARRIER_SIGNATURE',
          message: 'Carrier webhook signature or internal service authentication is missing or invalid',
        });
      }

      const { callId, eventType, durationSeconds = 0, ratePerMinute = 5.0, billingBlockSeconds = 30 } = request.body as any;

      if (eventType === 'call.completed') {
        const result = await walletService.settleCall({
          callId,
          durationSeconds,
          ratePerMinute,
          billingBlockSeconds,
          idempotencyKey: `carrier-settle:${callId}`,
        });
        return reply.status(200).send(result);
      } else {
        const result = await walletService.releaseReservation({
          callId,
          reason: `Carrier reported: ${eventType}`,
        });
        return reply.status(200).send(result);
      }
    }
  );
};
