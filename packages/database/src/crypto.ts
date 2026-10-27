import crypto from 'crypto';

/**
 * Hash a plain password using PBKDF2 with a cryptographically secure 16-byte salt,
 * 100,000 iterations of SHA-512.
 * Returns format: "salt:hash"
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a plain password against a stored "salt:hash" string using constant-time comparison.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, originalHash] = storedHash.split(':');
  if (!salt || !originalHash) return false;
  const computedHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  
  const computedBuf = Buffer.from(computedHash, 'hex');
  const originalBuf = Buffer.from(originalHash, 'hex');
  if (computedBuf.length !== originalBuf.length) return false;
  
  return crypto.timingSafeEqual(computedBuf, originalBuf);
}
