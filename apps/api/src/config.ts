import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
    MASTER_ENCRYPTION_KEY: z.string().length(64, 'MASTER_ENCRYPTION_KEY must be 64-char hex string'),
    TELEPHONY_PROVIDER: z.enum(['mock', 'plivo', 'twilio']).default('mock'),
    MOCK_WEBHOOK_SECRET: z.string().min(16).default('mock-webhook-secret-phase4-secure-key-123'),
    MOCK_STREAM_TOKEN_SECRET: z.string().min(16).default('mock-stream-secret-phase4-secure-key-456'),
    TELEPHONY_MAX_FRAME_SIZE: z.coerce.number().default(4096),
    TELEPHONY_MAX_QUEUED_FRAMES: z.coerce.number().default(50),
    TELEPHONY_MAX_QUEUED_BYTES: z.coerce.number().default(65536),
    TELEPHONY_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),
    STT_PROVIDER: z.enum(['mock', 'sarvam', 'deepgram']).default('mock'),
    TTS_PROVIDER: z.enum(['mock', 'sarvam', 'cartesia', 'azure']).default('mock'),
    LLM_PROVIDER: z.enum(['mock', 'gemini', 'anthropic']).default('mock'),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (data.JWT_SECRET.length < 32 || data.JWT_SECRET.toLowerCase().includes('dev') || data.JWT_SECRET.includes('12345678')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Production configuration rejects weak, default, or development JWT_SECRET (must be >= 32 secure chars)',
          path: ['JWT_SECRET'],
        });
      }
      if (data.MASTER_ENCRYPTION_KEY === '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Production configuration rejects placeholder sequential MASTER_ENCRYPTION_KEY',
          path: ['MASTER_ENCRYPTION_KEY'],
        });
      }
    }
  });

export const config = ConfigSchema.parse(process.env);
