import { FastifyRequest, FastifyReply } from 'fastify';
import { Role } from '@auris/database';
import { UserTokenPayload } from './auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    userPayload?: UserTokenPayload;
  }
}

export function requireAuth() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const decoded = await request.jwtVerify<UserTokenPayload>();
      request.userPayload = decoded;
    } catch (err: any) {
      if (err.code === 'FST_JWT_EXPIRED' || err.message?.toLowerCase().includes('expired')) {
        return reply.status(401).send({
          error: 'TOKEN_EXPIRED',
          message: 'Authentication token has expired. Please log in again.',
        });
      }
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing authentication token',
      });
    }
  };
}

export function requireRole(...allowedRoles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.userPayload) {
      return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    if (!allowedRoles.includes(request.userPayload.role)) {
      return reply.status(403).send({
        error: 'FORBIDDEN',
        message: 'You do not have the required permissions for this organization resource',
      });
    }
  };
}

export function enforceTenantIsolation(targetOrgIdParamName = 'orgId') {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as Record<string, string>;
    const targetOrgId = params[targetOrgIdParamName];

    if (!request.userPayload) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' });
    }

    if (targetOrgId && targetOrgId !== request.userPayload.organizationId) {
      return reply.status(403).send({
        error: 'CROSS_TENANT_ACCESS_DENIED',
        message: 'Access to resources of another organization is strictly forbidden',
      });
    }
  };
}
