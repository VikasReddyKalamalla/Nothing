import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '@auris/database';
import { AuthService } from './auth.service.js';
import { requireAuth } from './rbac.middleware.js';

export const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Register
  app.post(
    '/register',
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string().min(6),
          name: z.string().min(2),
          organizationName: z.string().min(2),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        password: string;
        name: string;
        organizationName: string;
      };

      try {
        const result = await AuthService.registerUser(body);
        const token = app.jwt.sign(
          {
            userId: result.user.id,
            email: result.user.email,
            organizationId: result.org.id,
            role: result.membership.role,
          },
          { expiresIn: '24h' }
        );

        const walletData = result.wallet
          ? {
              id: result.wallet.id,
              currency: result.wallet.currency,
              balanceCredits: Number(result.wallet.balanceCredits),
              reservedCredits: Number(result.wallet.reservedCredits),
              availableCredits: Number(result.wallet.balanceCredits) - Number(result.wallet.reservedCredits),
            }
          : undefined;

        return reply.status(201).send({
          token,
          user: {
            id: result.user.id,
            email: result.user.email,
            name: result.user.name,
          },
          org: {
            id: result.org.id,
            name: result.org.name,
            slug: result.org.slug,
          },
          organization: {
            id: result.org.id,
            name: result.org.name,
            slug: result.org.slug,
          },
          wallet: walletData,
        });
      } catch (err: any) {
        if (err.message === 'EMAIL_ALREADY_EXISTS') {
          return reply.status(409).send({ error: 'EMAIL_ALREADY_EXISTS', message: 'Email is already registered' });
        }
        throw err;
      }
    }
  );

  // Login
  app.post(
    '/login',
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string };

      try {
        const payload = await AuthService.validateCredentials(email, password);
        const token = app.jwt.sign(payload, { expiresIn: '24h' });

        const org = await prisma.organization.findUnique({
          where: { id: payload.organizationId },
          include: { wallet: true },
        });

        const walletData = org?.wallet
          ? {
              id: org.wallet.id,
              currency: org.wallet.currency,
              balanceCredits: Number(org.wallet.balanceCredits),
              reservedCredits: Number(org.wallet.reservedCredits),
              availableCredits: Number((Number(org.wallet.balanceCredits) - Number(org.wallet.reservedCredits)).toFixed(4)),
            }
          : undefined;

        const orgData = {
          id: payload.organizationId,
          name: org?.name || 'My Organization',
          slug: org?.slug || 'my-org',
          role: payload.role,
        };

        return reply.send({
          token,
          user: {
            id: payload.userId,
            email: payload.email,
            role: payload.role,
          },
          org: orgData,
          organization: orgData,
          wallet: walletData,
        });
      } catch (err: any) {
        return reply.status(401).send({
          error: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        });
      }
    }
  );

  // Profile
  app.get('/me', { preHandler: [requireAuth()] }, async (request, reply) => {
    const payload = request.userPayload!;
    const org = await prisma.organization.findUnique({
      where: { id: payload.organizationId },
      include: { wallet: true },
    });

    const walletData = org?.wallet
      ? {
          id: org.wallet.id,
          currency: org.wallet.currency,
          balanceCredits: Number(org.wallet.balanceCredits),
          reservedCredits: Number(org.wallet.reservedCredits),
          availableCredits: Number((Number(org.wallet.balanceCredits) - Number(org.wallet.reservedCredits)).toFixed(4)),
        }
      : undefined;

    const orgData = {
      id: payload.organizationId,
      name: org?.name || 'My Organization',
      slug: org?.slug || 'my-org',
      defaultLanguage: org?.defaultLanguage,
      smartFollowups: org?.smartFollowups,
      role: payload.role,
    };

    return reply.send({
      user: {
        ...payload,
        id: payload.userId,
      },
      org: orgData,
      organization: orgData,
      wallet: walletData,
    });
  });
};
