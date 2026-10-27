import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyWebsocket from '@fastify/websocket';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { config } from './config.js';
import { prisma } from '@auris/database';
import { authRoutes } from './modules/auth/auth.routes.js';
import { walletRoutes } from './modules/wallets/wallet.routes.js';
import { agentRoutes } from './modules/agents/agent.routes.js';
import { telephonyRoutes } from './modules/telephony/telephony.routes.js';
import { WalletService } from './modules/wallets/wallet.service.js';

export function buildServer() {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.NODE_ENV === 'production' ? 'info' : 'debug',
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers["x-auris-internal-secret"]',
                'req.headers["x-auris-signature"]',
                'req.headers["x-api-key"]',
                'req.query.token',
                'req.body.password',
                'req.body.token',
                'req.body.apiKey',
                'req.body.secret',
                '*.password',
                '*.secret',
                '*.token',
                '*.streamToken',
              ],
              censor: '[REDACTED]',
            },
          },
  }).withTypeProvider<ZodTypeProvider>();

  // Raw body preservation for cryptographically accurate webhook HMAC verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as any).rawBody = body;
      try {
        const text = body.toString('utf8');
        const json = text ? JSON.parse(text) : {};
        done(null, json);
      } catch (err: any) {
        done(err, undefined);
      }
    }
  );

  // Schema Compilers
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Global Error Handler to prevent leakage of credentials or internals
  app.setErrorHandler((error: any, request, reply) => {
    if (error.validation) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: error.message,
      });
    }

    if (config.NODE_ENV !== 'test') {
      request.log.error(error);
    }

    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      error: error.name || 'INTERNAL_SERVER_ERROR',
      message: statusCode === 500 ? 'An internal server error occurred' : error.message,
    });
  });

  // CORS
  app.register(cors, {
    origin: true,
    credentials: true,
  });

  // JWT with Default Expiry
  app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: {
      expiresIn: '24h',
    },
  });

  // Swagger Documentation
  app.register(swagger, {
    openapi: {
      info: {
        title: 'Auris Control Plane API',
        description: 'Multi-tenant AI voice-agent telecalling platform API',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${config.PORT}`,
          description: 'Local development server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  app.register(swaggerUi, {
    routePrefix: '/documentation',
  });

  // Healthcheck
  app.get('/health', async () => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'auris-control-plane',
      env: config.NODE_ENV,
    };
  });

  // WebSocket Support for Media Streaming
  app.register(fastifyWebsocket, {
    options: {
      maxPayload: config.TELEPHONY_MAX_FRAME_SIZE * 4,
    },
  });

  // Modules
  app.register(authRoutes, { prefix: '/v1/auth' });
  app.register(walletRoutes, { prefix: '/v1/wallets' });
  app.register(agentRoutes, { prefix: '/v1/agents' });
  app.register(telephonyRoutes, { prefix: '/v1/telephony' });

  // In-process Background Scheduled Process: Expired Reservation Recovery (Phase 1 Safe Recovery)
  let reconciliationInterval: NodeJS.Timeout | null = null;
  if (config.NODE_ENV !== 'test') {
    const walletService = new WalletService(prisma);
    reconciliationInterval = setInterval(async () => {
      try {
        const reconciled = await walletService.reconcileExpiredReservations();
        if (reconciled && reconciled.length > 0) {
          app.log.info({ count: reconciled.length }, 'Scheduled recovery: Reconciled expired wallet reservations');
        }
      } catch (err) {
        app.log.error(err, 'Failed to run scheduled reservation reconciliation');
      }
    }, 60_000);
  }

  app.addHook('onClose', async () => {
    if (reconciliationInterval) {
      clearInterval(reconciliationInterval);
      reconciliationInterval = null;
    }
  });

  return app;
}

async function start() {
  const app = buildServer();
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    console.log(`🚀 Auris API Server listening on http://${config.HOST}:${config.PORT}`);
    console.log(`📖 Swagger API Docs available at http://${config.HOST}:${config.PORT}/documentation`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  start();
}
