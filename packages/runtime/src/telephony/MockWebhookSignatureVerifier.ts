import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  WebhookVerificationResult,
} from './TelephonyTypes.js';
import {
  IWebhookSignatureVerifier,
  WebhookVerificationContext,
} from './WebhookSignatureVerifier.js';

export interface MockWebhookVerifierOptions {
  secret: string;
  toleranceSeconds?: number;
  maxReplayCacheSize?: number;
}

export class MockWebhookSignatureVerifier implements IWebhookSignatureVerifier {
  private readonly secret: string;
  private readonly toleranceSeconds: number;
  private readonly maxReplayCacheSize: number;
  private readonly replayCache: Map<string, number> = new Map();

  constructor(options: MockWebhookVerifierOptions) {
    if (!options.secret || options.secret.trim().length === 0) {
      throw new Error('MockWebhookSignatureVerifier requires a non-empty secret');
    }
    this.secret = options.secret;
    this.toleranceSeconds = options.toleranceSeconds ?? 300; // 5 minutes
    this.maxReplayCacheSize = options.maxReplayCacheSize ?? 10_000;
  }

  /**
   * Helper to compute a signature for testing/mock provider simulation.
   */
  public computeSignature(rawBody: Buffer | string, timestamp: number): string {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const canonical = `${timestamp}.${bodyStr}`;
    return crypto.createHmac('sha256', this.secret).update(canonical, 'utf8').digest('hex');
  }

  /**
   * Helper to format the full x-auris-signature header value.
   */
  public formatHeader(rawBody: Buffer | string, timestamp = Math.floor(Date.now() / 1000)): string {
    const sig = this.computeSignature(rawBody, timestamp);
    return `t=${timestamp},v1=${sig}`;
  }

  /**
   * Verify an incoming webhook request context against the canonical HMAC-SHA256 signature.
   */
  public verify(context: WebhookVerificationContext): WebhookVerificationResult {
    if (!this.secret) {
      return { valid: false, reason: 'MISSING_SECRET' };
    }

    const header = context.headers['x-auris-signature'];
    const rawHeader = Array.isArray(header) ? header[0] : header;

    if (!rawHeader || typeof rawHeader !== 'string') {
      return { valid: false, reason: 'MISSING_SIGNATURE' };
    }

    // Parse header: t=...,v1=...
    const parts = rawHeader.split(',');
    let timestampStr: string | undefined;
    let signatureHex: string | undefined;

    for (const part of parts) {
      const [key, value] = part.trim().split('=');
      if (key === 't') {
        timestampStr = value;
      } else if (key === 'v1') {
        signatureHex = value;
      }
    }

    if (!timestampStr || !signatureHex) {
      return { valid: false, reason: 'MALFORMED_HEADER' };
    }

    // SEC-07: Strictly enforce 64-character hex format for SHA-256 signature
    if (!/^[0-9a-f]{64}$/i.test(signatureHex)) {
      return { valid: false, reason: 'MALFORMED_HEADER' };
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp) || timestamp <= 0) {
      return { valid: false, reason: 'MALFORMED_HEADER' };
    }

    // SEC-06: Asymmetric timestamp bounds (tolerance in past, max 15s future clock drift)
    const nowSec = Math.floor(Date.now() / 1000);
    const maxFutureDriftSec = 15;
    if (timestamp < nowSec - this.toleranceSeconds || timestamp > nowSec + maxFutureDriftSec) {
      return { valid: false, reason: 'EXPIRED_TIMESTAMP', timestamp };
    }

    // Check Replay Protection
    const replayKey = `${timestamp}:${signatureHex}`;
    if (this.replayCache.has(replayKey)) {
      return { valid: false, reason: 'REPLAY_DETECTED', timestamp };
    }

    // Verify HMAC-SHA256
    const expectedSigHex = this.computeSignature(context.rawBody, timestamp);

    try {
      const actualBuf = Buffer.from(signatureHex, 'hex');
      const expectedBuf = Buffer.from(expectedSigHex, 'hex');

      if (actualBuf.length !== expectedBuf.length) {
        return { valid: false, reason: 'INVALID_SIGNATURE', timestamp };
      }

      const match = crypto.timingSafeEqual(actualBuf, expectedBuf);
      if (!match) {
        return { valid: false, reason: 'INVALID_SIGNATURE', timestamp };
      }
    } catch {
      return { valid: false, reason: 'INVALID_SIGNATURE', timestamp };
    }

    // Record in replay cache and prune expired entries
    this.recordReplay(replayKey, timestamp);

    return { valid: true, reason: 'VALID', timestamp };
  }

  private recordReplay(key: string, timestamp: number): void {
    this.replayCache.set(key, timestamp);

    // Prune if cache grows too large
    if (this.replayCache.size > this.maxReplayCacheSize) {
      const cutoff = Math.floor(Date.now() / 1000) - this.toleranceSeconds;
      for (const [k, ts] of this.replayCache.entries()) {
        if (ts < cutoff) {
          this.replayCache.delete(k);
        }
      }
    }
  }

  /**
   * Reset the replay cache (useful for isolated tests).
   */
  public clearReplayCache(): void {
    this.replayCache.clear();
  }
}
