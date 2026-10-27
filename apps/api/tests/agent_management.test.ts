import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Role, AgentRoleType, VoiceTier } from '@auris/database';
import { buildServer } from '../src/server.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { FastifyInstance } from 'fastify';

describe('Auris Agent Management & Tenancy Tests', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let orgAToken: string;
  let orgAId: string;
  let orgBToken: string;
  let orgBId: string;
  let createdAgentId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = buildServer();
    await app.ready();

    // Register Org A
    const regA = await AuthService.registerUser({
      email: `agent-org-a-${Date.now()}@auris.local`,
      password: 'password123',
      name: 'Agent Admin A',
      organizationName: `Agent Org A ${Date.now()}`,
    });
    orgAId = regA.org.id;
    orgAToken = app.jwt.sign({
      userId: regA.user.id,
      email: regA.user.email,
      organizationId: regA.org.id,
      role: Role.OWNER,
    });

    // Register Org B
    const regB = await AuthService.registerUser({
      email: `agent-org-b-${Date.now()}@auris.local`,
      password: 'password123',
      name: 'Agent Admin B',
      organizationName: `Agent Org B ${Date.now()}`,
    });
    orgBId = regB.org.id;
    orgBToken = app.jwt.sign({
      userId: regB.user.id,
      email: regB.user.email,
      organizationId: regB.org.id,
      role: Role.OWNER,
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('allows owner of Org A to create a voice agent with immutable snapshot version 1', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: {
        authorization: `Bearer ${orgAToken}`,
      },
      payload: {
        name: 'Sneha Lead Generator',
        roleType: AgentRoleType.INSTANT_LEAD,
        voiceTier: VoiceTier.STANDARD,
        voiceId: 'sarvam-bulbul-sneha',
        primaryLanguage: 'Telugu + English',
        englishEnhance: true,
        promptTemplate: 'You are Sneha, qualifying real estate leads in Kondapur.',
      },
    });

    expect(response.statusCode).toBe(201);
    const agent = JSON.parse(response.body);
    expect(agent).toHaveProperty('id');
    expect(agent.name).toBe('Sneha Lead Generator');
    expect(agent.organizationId).toBe(orgAId);
    createdAgentId = agent.id;

    // Verify version 1 snapshot was created in database
    const version = await prisma.agentVersion.findUnique({
      where: {
        agentId_versionNumber: {
          agentId: createdAgentId,
          versionNumber: 1,
        },
      },
    });
    expect(version).not.toBeNull();
    expect(version?.versionNumber).toBe(1);
  });

  it('lists only Org A agents when queried by Org A user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: {
        authorization: `Bearer ${orgAToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const agents = JSON.parse(response.body);
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe(createdAgentId);
  });

  it('returns empty agent list when Org B queries their agents (tenant isolation)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: {
        authorization: `Bearer ${orgBToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const agents = JSON.parse(response.body);
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBe(0);
  });

  it('prevents Org B user from retrieving Org A agent by ID (returns 404 AGENT_NOT_FOUND)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/agents/${createdAgentId}`,
      headers: {
        authorization: `Bearer ${orgBToken}`,
      },
    });

    expect(response.statusCode).toBe(404);
    const data = JSON.parse(response.body);
    expect(data.error).toBe('AGENT_NOT_FOUND');
  });

  it('allows Org A user to retrieve their agent with snapshot versions', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/agents/${createdAgentId}`,
      headers: {
        authorization: `Bearer ${orgAToken}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const agent = JSON.parse(response.body);
    expect(agent.id).toBe(createdAgentId);
    expect(agent.versions.length).toBeGreaterThanOrEqual(1);
    expect(agent.versions[0].versionNumber).toBe(1);
  });
});
