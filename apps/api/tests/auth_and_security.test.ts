import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@auris/database';
import { buildServer } from '../src/server.js';
import { FastifyInstance } from 'fastify';

describe('Auris Priority 4 & 5: Authentication, JWT Expiry & Security Tests', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('1. User Registration Flow & Input Validation', () => {
    const testEmail = `reg-test-${Date.now()}@auris.local`;

    it('successfully registers a new user, organization, wallet, and policy', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'securePassword123!',
          name: 'Security Tester',
          organizationName: 'Security Testing Corp',
        },
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty('token');
      expect(data.user.email).toBe(testEmail.toLowerCase());
      expect(data.user).not.toHaveProperty('passwordHash');
      expect(data.organization).toHaveProperty('id');
      expect(data.organization.name).toBe('Security Testing Corp');
    });

    it('rejects duplicate email registration with 409 EMAIL_ALREADY_EXISTS', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: testEmail,
          password: 'anotherPassword123!',
          name: 'Imposter Tester',
          organizationName: 'Duplicate Org',
        },
      });

      expect(response.statusCode).toBe(409);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('rejects invalid email and weak short passwords with 400 validation error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'not-an-email',
          password: '123',
          name: 'Short',
          organizationName: 'Org',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('2. User Authentication & Seed Account Parity', () => {
    it('successfully authenticates the seeded development administrator account with PBKDF2 verification', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'vikasreddyk0@gmail.com',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty('token');
      expect(data.user.email).toBe('vikasreddyk0@gmail.com');
      expect(data.organization.role).toBe('OWNER');
      expect(data.user).not.toHaveProperty('passwordHash');
    });

    it('rejects incorrect password with 401 INVALID_CREDENTIALS', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'vikasreddyk0@gmail.com',
          password: 'WrongPassword!',
        },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('INVALID_CREDENTIALS');
      expect(data.message).toBe('Invalid email or password');
    });

    it('rejects nonexistent user email with 401 INVALID_CREDENTIALS', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'nonexistent-user-12345@auris.local',
          password: 'SomePassword123!',
        },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('3. JWT Expiration, Validation & Tampering Protection', () => {
    let validToken: string;

    beforeAll(async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'vikasreddyk0@gmail.com',
          password: 'password123',
        },
      });
      const data = JSON.parse(loginRes.body);
      validToken = data.token;
    });

    it('allows access to protected route /v1/auth/me with valid unexpired token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.user.email).toBe('vikasreddyk0@gmail.com');
      expect(data.user).toHaveProperty('exp'); // Confirms exp claim is present
    });

    it('strictly rejects expired tokens with 401 TOKEN_EXPIRED', async () => {
      // Sign token with 1 second expiration (JWT exp claim is in seconds)
      const expiredToken = app.jwt.sign(
        {
          userId: 'test-user-id',
          email: 'expired@auris.local',
          organizationId: 'test-org-id',
          role: 'OWNER',
        },
        { expiresIn: 1 }
      );

      // Wait 1100ms for the 1-second token to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const response = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${expiredToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('TOKEN_EXPIRED');
      expect(data.message).toContain('expired');
    });

    it('rejects tampered or forged JWT signatures with 401 UNAUTHORIZED', async () => {
      const tamperedToken = `${validToken.slice(0, -6)}abcdef`;

      const response = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${tamperedToken}`,
        },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('UNAUTHORIZED');
    });

    it('rejects unauthenticated requests without authorization header with 401 UNAUTHORIZED', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error).toBe('UNAUTHORIZED');
    });
  });
});
