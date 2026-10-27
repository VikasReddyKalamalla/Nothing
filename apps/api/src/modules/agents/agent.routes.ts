import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma, AgentRoleType, VoiceTier, Role } from '@auris/database';
import { requireAuth, requireRole } from '../auth/rbac.middleware.js';

function formatAgent(agent: any) {
  return {
    ...agent,
    systemPrompt: agent.promptTemplate,
    role: agent.roleType,
    status: agent.isActive ? 'ACTIVE' : 'PAUSED',
  };
}

function mapRoleType(roleOrRoleType?: string): AgentRoleType {
  if (!roleOrRoleType) return AgentRoleType.INSTANT_LEAD;
  if (roleOrRoleType === 'RECEPTIONIST') return AgentRoleType.RECEPTIONIST;
  if (roleOrRoleType === 'BULK_CAMPAIGN' || roleOrRoleType === 'BULK') return AgentRoleType.BULK_CAMPAIGN;
  if (roleOrRoleType === 'INSTANT_LEAD' || roleOrRoleType === 'TELECALLER' || roleOrRoleType === 'CUSTOM') return AgentRoleType.INSTANT_LEAD;
  if (Object.values(AgentRoleType).includes(roleOrRoleType as AgentRoleType)) {
    return roleOrRoleType as AgentRoleType;
  }
  return AgentRoleType.INSTANT_LEAD;
}

export const agentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const agentBodySchema = z.object({
    name: z.string().min(2),
    roleType: z.string().optional(),
    role: z.string().optional(),
    voiceTier: z.nativeEnum(VoiceTier).default(VoiceTier.STANDARD),
    voiceId: z.string().default('sarvam-bulbul-sneha'),
    primaryLanguage: z.string().default('English'),
    secondaryLanguages: z.array(z.string()).optional(),
    englishEnhance: z.boolean().default(true),
    promptTemplate: z.string().min(10).optional(),
    systemPrompt: z.string().min(10).optional(),
    interruptionSensitivity: z.number().optional(),
    llmTemperature: z.number().optional(),
  });

  // Handler for creating an agent in target organization
  const createAgentHandler = async (request: any, reply: any, targetOrgId: string) => {
    const userOrgId = request.userPayload!.organizationId;
    const userId = request.userPayload!.userId;

    if (targetOrgId !== userOrgId) {
      return reply.status(403).send({
        error: 'CROSS_TENANT_ACCESS_DENIED',
        message: 'Access to resources of another organization is strictly forbidden',
      });
    }

    const body = request.body as any;
    const prompt = body.promptTemplate || body.systemPrompt;
    if (!prompt || prompt.length < 10) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Prompt template / system prompt must be at least 10 characters long',
      });
    }

    const effectiveRoleType = mapRoleType(body.roleType || body.role);

    const agent = await prisma.$transaction(async (tx) => {
      const created = await tx.agent.create({
        data: {
          organizationId: targetOrgId,
          name: body.name,
          roleType: effectiveRoleType,
          voiceTier: body.voiceTier || VoiceTier.STANDARD,
          voiceId: body.voiceId || 'sarvam-bulbul-sneha',
          primaryLanguage: body.primaryLanguage || 'English',
          englishEnhance: body.englishEnhance ?? true,
          promptTemplate: prompt,
        },
      });

      // Create immutable version 1 snapshot
      await tx.agentVersion.create({
        data: {
          agentId: created.id,
          versionNumber: 1,
          snapshotJson: {
            name: created.name,
            roleType: created.roleType,
            voiceTier: created.voiceTier,
            voiceId: created.voiceId,
            primaryLanguage: created.primaryLanguage,
            promptTemplate: created.promptTemplate,
          },
          publishedBy: userId,
        },
      });

      return created;
    });

    return reply.status(201).send(formatAgent(agent));
  };

  // List all agents belonging to the authenticated user's organization
  app.get('/', { preHandler: [requireAuth()] }, async (request, reply) => {
    const orgId = request.userPayload!.organizationId;

    const agents = await prisma.agent.findMany({
      where: { organizationId: orgId },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send(agents.map(formatAgent));
  });

  // Create new agent definition (Scoped to user's org)
  app.post(
    '/',
    {
      preHandler: [requireAuth(), requireRole(Role.OWNER, Role.ADMIN)],
      schema: { body: agentBodySchema },
    },
    async (request, reply) => {
      return createAgentHandler(request, reply, request.userPayload!.organizationId);
    }
  );

  // Create new agent definition (Scoped with explicit :orgId in path)
  app.post(
    '/:orgId',
    {
      preHandler: [requireAuth(), requireRole(Role.OWNER, Role.ADMIN)],
      schema: { body: agentBodySchema },
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      return createAgentHandler(request, reply, orgId);
    }
  );

  // Smart single-param route: can be either /:id (agentId) OR /:orgId (list agents for org)
  app.get('/:param', { preHandler: [requireAuth()] }, async (request, reply) => {
    const userOrgId = request.userPayload!.organizationId;
    const { param } = request.params as { param: string };

    // Check if param is an organization ID
    const orgMatch = await prisma.organization.findUnique({
      where: { id: param },
      select: { id: true },
    });

    if (orgMatch) {
      if (orgMatch.id !== userOrgId) {
        return reply.status(403).send({
          error: 'CROSS_TENANT_ACCESS_DENIED',
          message: 'Access to resources of another organization is strictly forbidden',
        });
      }

      const agents = await prisma.agent.findMany({
        where: { organizationId: userOrgId },
        include: {
          versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send(agents.map(formatAgent));
    }

    // Otherwise, treat param as agentId
    const agent = await prisma.agent.findFirst({
      where: { id: param, organizationId: userOrgId },
      include: {
        versions: { orderBy: { versionNumber: 'desc' } },
        knowledgeSources: true,
      },
    });

    if (!agent) {
      return reply.status(404).send({
        error: 'AGENT_NOT_FOUND',
        message: 'Agent does not exist or access denied',
      });
    }

    return reply.send(formatAgent(agent));
  });

  // Explicit two-param route: /:orgId/:agentId
  app.get('/:orgId/:agentId', { preHandler: [requireAuth()] }, async (request, reply) => {
    const userOrgId = request.userPayload!.organizationId;
    const { orgId, agentId } = request.params as { orgId: string; agentId: string };

    if (orgId !== userOrgId) {
      return reply.status(403).send({
        error: 'CROSS_TENANT_ACCESS_DENIED',
        message: 'Access to resources of another organization is strictly forbidden',
      });
    }

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, organizationId: userOrgId },
      include: {
        versions: { orderBy: { versionNumber: 'desc' } },
        knowledgeSources: true,
      },
    });

    if (!agent) {
      return reply.status(404).send({
        error: 'AGENT_NOT_FOUND',
        message: 'Agent does not exist or access denied',
      });
    }

    return reply.send(formatAgent(agent));
  });

  // Update agent status or configuration: /:orgId/:agentId or /:agentId
  app.put('/:orgId/:agentId', { preHandler: [requireAuth(), requireRole(Role.OWNER, Role.ADMIN)] }, async (request, reply) => {
    const userOrgId = request.userPayload!.organizationId;
    const { orgId, agentId } = request.params as { orgId: string; agentId: string };

    if (orgId !== userOrgId) {
      return reply.status(403).send({
        error: 'CROSS_TENANT_ACCESS_DENIED',
        message: 'Access to resources of another organization is strictly forbidden',
      });
    }

    const body = request.body as any;
    const existing = await prisma.agent.findFirst({
      where: { id: agentId, organizationId: userOrgId },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'AGENT_NOT_FOUND', message: 'Agent not found' });
    }

    const updated = await prisma.agent.update({
      where: { id: agentId },
      data: {
        name: body.name || existing.name,
        isActive: body.status !== undefined ? body.status === 'ACTIVE' : (body.isActive !== undefined ? body.isActive : existing.isActive),
        promptTemplate: body.promptTemplate || body.systemPrompt || existing.promptTemplate,
      },
    });

    return reply.send(formatAgent(updated));
  });

  // Delete agent: /:orgId/:agentId
  app.delete('/:orgId/:agentId', { preHandler: [requireAuth(), requireRole(Role.OWNER, Role.ADMIN)] }, async (request, reply) => {
    const userOrgId = request.userPayload!.organizationId;
    const { orgId, agentId } = request.params as { orgId: string; agentId: string };

    if (orgId !== userOrgId) {
      return reply.status(403).send({
        error: 'CROSS_TENANT_ACCESS_DENIED',
        message: 'Access to resources of another organization is strictly forbidden',
      });
    }

    const existing = await prisma.agent.findFirst({
      where: { id: agentId, organizationId: userOrgId },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'AGENT_NOT_FOUND', message: 'Agent not found' });
    }

    await prisma.agent.delete({ where: { id: agentId } });
    return reply.send({ success: true, deletedAgentId: agentId });
  });
};
