import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Role, AgentRoleType, VoiceTier } from '@auris/database';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';

describe('Phase 2: Frontend-to-API Integration & Tenant Security Tests', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  // Org A
  let userAToken: string;
  let orgAId: string;
  let userAEmail: string;

  // Org B
  let userBToken: string;
  let orgBId: string;
  let userBEmail: string;

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = buildServer();
    await app.ready();

    userAEmail = `org-a-${Date.now()}@auris.local`;
    userBEmail = `org-b-${Date.now()}@auris.local`;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('1. Authentication, Registration & Session Hydration', () => {
    it('successfully registers Organization A and returns JWT token and wallet', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          name: 'Doctor A',
          email: userAEmail,
          password: 'Password123!',
          organizationName: `Apex Healthcare ${Date.now()}`,
        },
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data.token).toBeDefined();
      expect(data.user.email).toBe(userAEmail);
      expect(data.org.id).toBeDefined();
      expect(data.wallet.balanceCredits).toBe(50.0);

      userAToken = data.token;
      orgAId = data.org.id;
    });

    it('successfully registers Organization B and returns distinct tenant credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          name: 'Manager B',
          email: userBEmail,
          password: 'Password123!',
          organizationName: `Sai Realty ${Date.now()}`,
        },
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data.token).toBeDefined();
      expect(data.org.id).toBeDefined();
      expect(data.org.id).not.toBe(orgAId);

      userBToken = data.token;
      orgBId = data.org.id;
    });

    it('successfully logs in with valid credentials and receives fresh session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: userAEmail,
          password: 'Password123!',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.token).toBeDefined();
      expect(data.user.email).toBe(userAEmail);
      expect(data.org.id).toBe(orgAId);
      expect(data.wallet.availableCredits).toBe(50.0);
    });

    it('rejects invalid password with 401 INVALID_CREDENTIALS', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: userAEmail,
          password: 'WrongPassword456',
        },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('INVALID_CREDENTIALS');
    });

    it('hydrates profile via GET /v1/auth/me with Bearer token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.user.email).toBe(userAEmail);
      expect(data.org.id).toBe(orgAId);
      expect(data.wallet.currency).toBe('INR');
      expect(data.wallet.balanceCredits).toBe(50.0);
    });

    it('rejects unauthenticated requests to GET /v1/auth/me with 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('UNAUTHORIZED');
    });
  });

  describe('2. Agent Creation, Retrieval & Lifecycle (Real Database)', () => {
    let createdAgentId: string;

    it('creates a new AI employee in Organization A with Telugu and English enhance', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/agents/${orgAId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
        payload: {
          name: 'Kondapur Clinic Receptionist',
          role: 'RECEPTIONIST',
          systemPrompt:
            'You are Dr. Reddy’s Clinic Receptionist. Greet caller politely in Telugu or English, ask for their symptoms, and book a Saturday evening slot.',
          primaryLanguage: 'తెలుగు',
          secondaryLanguages: ['English'],
          englishEnhance: true,
          voiceTier: 'STANDARD',
          interruptionSensitivity: 0.7,
          llmTemperature: 0.3,
        },
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data.id).toBeDefined();
      expect(data.organizationId).toBe(orgAId);
      expect(data.name).toBe('Kondapur Clinic Receptionist');
      expect(data.role).toBe('RECEPTIONIST');
      expect(data.status).toBe('ACTIVE');
      expect(data.primaryLanguage).toBe('తెలుగు');
      expect(data.voiceTier).toBe('STANDARD');

      createdAgentId = data.id;
    });

    it('lists agents for Organization A returning the created employee', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/agents/${orgAId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].id).toBe(createdAgentId);
      expect(data[0].name).toBe('Kondapur Clinic Receptionist');
    });

    it('retrieves single agent details by ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/agents/${orgAId}/${createdAgentId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.id).toBe(createdAgentId);
      expect(data.systemPrompt).toContain('Dr. Reddy’s Clinic Receptionist');
    });

    it('updates agent status from ACTIVE to PAUSED', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/v1/agents/${orgAId}/${createdAgentId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
        payload: {
          status: 'PAUSED',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.status).toBe('PAUSED');

      // Verify in DB
      const dbAgent = await prisma.agent.findUnique({ where: { id: createdAgentId } });
      expect(dbAgent?.isActive).toBe(false);
    });

    it('deletes agent from database', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/agents/${orgAId}/${createdAgentId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);

      // Verify list is now empty
      const listResponse = await app.inject({
        method: 'GET',
        url: `/v1/agents/${orgAId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });
      const listData = JSON.parse(listResponse.body);
      expect(listData.length).toBe(0);
    });

    it('rejects agent creation with short prompt (< 10 chars) with 400 validation error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/agents/${orgAId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
        payload: {
          name: 'Invalid Agent',
          role: 'TELECALLER',
          systemPrompt: 'Too short',
          primaryLanguage: 'English',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('3. Wallet Balance, Top-Up & Transaction History', () => {
    it('fetches real-time wallet balance and transaction ledger', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/wallets/${orgAId}/balance`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.currency).toBe('INR');
      expect(data.balanceCredits).toBe(50.0);
      expect(data.availableCredits).toBe(50.0);
      expect(data.reservedCredits).toBe(0.0);
      expect(Array.isArray(data.recentTransactions)).toBe(true);
    });

    it('performs wallet top-up of ₹500 and records audit ledger transaction', async () => {
      const idempotencyKey = `test-topup-${Date.now()}`;
      const response = await app.inject({
        method: 'POST',
        url: `/v1/wallets/${orgAId}/topup`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
        payload: {
          amountCredits: 500.0,
          idempotencyKey,
          description: 'Test recharge of ₹500.00',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.status).toBe('SUCCESS');
      expect(data.newBalance).toBe(550.0);

      // Verify balance reflects 550.0
      const balanceResponse = await app.inject({
        method: 'GET',
        url: `/v1/wallets/${orgAId}/balance`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });
      const balanceData = JSON.parse(balanceResponse.body);
      expect(balanceData.balanceCredits).toBe(550.0);
      expect(balanceData.recentTransactions.length).toBeGreaterThanOrEqual(1);
      expect(balanceData.recentTransactions[0].description).toBe('Test recharge of ₹500.00');
    });

    it('rejects top-up with non-positive amount with 400 validation error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/wallets/${orgAId}/topup`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
        payload: {
          amountCredits: -50.0,
          idempotencyKey: `neg-topup-${Date.now()}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('4. Strict Cross-Tenant Isolation Enforcement', () => {
    it('strictly forbids User A from listing User B agents with 403 CROSS_TENANT_ACCESS_DENIED', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/agents/${orgBId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('CROSS_TENANT_ACCESS_DENIED');
    });

    it('strictly forbids User A from creating an agent in Org B with 403 CROSS_TENANT_ACCESS_DENIED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/agents/${orgBId}`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
        payload: {
          name: 'Malicious Injected Agent',
          role: 'TELECALLER',
          systemPrompt: 'Should be blocked by tenant isolation middleware.',
          primaryLanguage: 'English',
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('CROSS_TENANT_ACCESS_DENIED');
    });

    it('strictly forbids User A from viewing Org B wallet balance with 403 CROSS_TENANT_ACCESS_DENIED', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/wallets/${orgBId}/balance`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('CROSS_TENANT_ACCESS_DENIED');
    });

    it('strictly forbids User A from topping up Org B wallet with 403 CROSS_TENANT_ACCESS_DENIED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/wallets/${orgBId}/topup`,
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
        payload: {
          amountCredits: 1000.0,
          idempotencyKey: `malicious-topup-${Date.now()}`,
        },
      });

      expect(response.statusCode).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('CROSS_TENANT_ACCESS_DENIED');
    });
  });
});
