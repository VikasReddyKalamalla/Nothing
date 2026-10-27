import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { StreamTokenPayload } from './TelephonyTypes.js';
import { IStreamTokenNonceStore } from './IStreamTokenNonceStore.js';
import {
  ExpiredStreamTokenError,
  InvalidStreamTokenError,
  StreamTokenReusedError,
} from './TelephonyErrors.js';

export interface StreamTokenManagerOptions {
  secret: string;
  defaultTtlSeconds?: number;
  nonceStore?: IStreamTokenNonceStore;
}

export class StreamTokenManager {
  private readonly secret: string;
  private readonly defaultTtlSeconds: number;
  private readonly claimedNonces: Map<string, number> = new Map(); // nonce -> expiresAt
  private readonly nonceStore?: IStreamTokenNonceStore;

  constructor(options: StreamTokenManagerOptions) {
    if (!options.secret || options.secret.trim().length === 0) {
      throw new Error('StreamTokenManager requires a non-empty secret');
    }
    this.secret = options.secret;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 60; // 60s short TTL
    this.nonceStore = options.nonceStore;
  }

  /**
   * Generate and sign a new single-purpose media stream token.
   */
  public generateToken(params: {
    callId: string;
    organizationId: string;
    ttlSeconds?: number;
  }): { token: string; expiresAt: number } {
    const ttl = params.ttlSeconds ?? this.defaultTtlSeconds;
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + ttl;
    const nonce = crypto.randomBytes(16).toString('hex');

    const payload: StreamTokenPayload = {
      callId: params.callId,
      organizationId: params.organizationId,
      purpose: 'media_stream',
      expiresAt,
      nonce,
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(payloadB64, 'utf8')
      .digest('base64url');

    return {
      token: `${payloadB64}.${signature}`,
      expiresAt,
    };
  }

  /**
   * Verify and atomically claim a stream token for a call session.
   * Throws typed errors on verification failures.
   */
  public verifyAndClaimToken(
    token: string,
    expectedCallId?: string,
    expectedOrgId?: string
  ): StreamTokenPayload {
    if (!token || typeof token !== 'string') {
      throw new InvalidStreamTokenError('Missing or empty stream token');
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new InvalidStreamTokenError('Malformed stream token structure');
    }

    const [payloadB64, signature] = parts;

    // 1. Verify HMAC signature with constant-time equality
    const expectedSig = crypto
      .createHmac('sha256', this.secret)
      .update(payloadB64, 'utf8')
      .digest('base64url');

    try {
      const sigBuf = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expectedSig, 'utf8');
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        throw new InvalidStreamTokenError('Stream token signature verification failed');
      }
    } catch (err: any) {
      if (err instanceof InvalidStreamTokenError) throw err;
      throw new InvalidStreamTokenError('Invalid stream token signature');
    }

    // 2. Decode payload JSON
    let payload: StreamTokenPayload;
    try {
      const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
      payload = JSON.parse(jsonStr);
    } catch {
      throw new InvalidStreamTokenError('Stream token payload is not valid JSON');
    }

    // 3. Validate purpose
    if (payload.purpose !== 'media_stream') {
      throw new InvalidStreamTokenError(`Invalid stream token purpose: ${payload.purpose}`);
    }

    // 4. Validate expiry
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.expiresAt < nowSec) {
      throw new ExpiredStreamTokenError(`Stream token expired at ${new Date(payload.expiresAt * 1000).toISOString()}`);
    }

    // 5. Validate expected callId
    if (expectedCallId && payload.callId !== expectedCallId) {
      throw new InvalidStreamTokenError('Stream token is bound to a different call');
    }

    // 6. Validate expected organizationId
    if (expectedOrgId && payload.organizationId !== expectedOrgId) {
      throw new InvalidStreamTokenError('Stream token is bound to a different organization');
    }

    // 7. Atomic Single-Use Nonce Check & Claim
    if (!payload.nonce) {
      throw new InvalidStreamTokenError('Stream token missing nonce');
    }

    if (this.claimedNonces.has(payload.nonce)) {
      throw new StreamTokenReusedError('Stream token has already been claimed');
    }

    this.claimedNonces.set(payload.nonce, payload.expiresAt);
    this.pruneClaimedNonces();

    return payload;
  }

  /**
   * Asynchronously verify and atomically claim a stream token.
   * If a distributed IStreamTokenNonceStore is configured, delegates to it atomically.
   */
  public async verifyAndClaimTokenAsync(
    token: string,
    expectedCallId?: string,
    expectedOrgId?: string
  ): Promise<StreamTokenPayload> {
    if (this.nonceStore) {
      // Decode and verify without claiming memory nonce yet
      const payload = this.verifyTokenStructure(token, expectedCallId, expectedOrgId);
      const claimed = await this.nonceStore.claimNonce(payload.nonce, payload.expiresAt);
      if (!claimed) {
        throw new StreamTokenReusedError('Stream token has already been claimed');
      }
      return payload;
    }

    return this.verifyAndClaimToken(token, expectedCallId, expectedOrgId);
  }

  private verifyTokenStructure(
    token: string,
    expectedCallId?: string,
    expectedOrgId?: string
  ): StreamTokenPayload {
    if (!token || typeof token !== 'string') {
      throw new InvalidStreamTokenError('Missing or empty stream token');
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new InvalidStreamTokenError('Malformed stream token structure');
    }

    const [payloadB64, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', this.secret)
      .update(payloadB64, 'utf8')
      .digest('base64url');

    try {
      const sigBuf = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expectedSig, 'utf8');
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        throw new InvalidStreamTokenError('Stream token signature verification failed');
      }
    } catch (err: any) {
      if (err instanceof InvalidStreamTokenError) throw err;
      throw new InvalidStreamTokenError('Invalid stream token signature');
    }

    let payload: StreamTokenPayload;
    try {
      const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
      payload = JSON.parse(jsonStr);
    } catch {
      throw new InvalidStreamTokenError('Stream token payload is not valid JSON');
    }

    if (payload.purpose !== 'media_stream') {
      throw new InvalidStreamTokenError(`Invalid stream token purpose: ${payload.purpose}`);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.expiresAt < nowSec) {
      throw new ExpiredStreamTokenError(`Stream token expired at ${new Date(payload.expiresAt * 1000).toISOString()}`);
    }

    if (expectedCallId && payload.callId !== expectedCallId) {
      throw new InvalidStreamTokenError('Stream token is bound to a different call');
    }

    if (expectedOrgId && payload.organizationId !== expectedOrgId) {
      throw new InvalidStreamTokenError('Stream token is bound to a different organization');
    }

    if (!payload.nonce) {
      throw new InvalidStreamTokenError('Stream token missing nonce');
    }

    return payload;
  }

  private pruneClaimedNonces(): void {
    if (this.claimedNonces.size > 5000) {
      const nowSec = Math.floor(Date.now() / 1000);
      for (const [nonce, expiresAt] of this.claimedNonces.entries()) {
        if (expiresAt < nowSec) {
          this.claimedNonces.delete(nonce);
        }
      }
    }
  }

  public clearClaimedNonces(): void {
    this.claimedNonces.clear();
  }

  public static sanitize(token?: string): string {
    if (!token) return '';
    return '[STREAM_TOKEN_REDACTED]';
  }
}
