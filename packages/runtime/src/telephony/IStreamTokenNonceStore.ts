export interface IStreamTokenNonceStore {
  /**
   * Atomically checks if the nonce exists; if not, marks it as claimed and returns true.
   * If already claimed, returns false.
   *
   * @param nonce Cryptographically secure random nonce string
   * @param expiresAtSec Unix epoch timestamp in seconds when the token expires
   * @returns true if nonce was successfully claimed (first use); false if duplicate/already claimed
   */
  claimNonce(nonce: string, expiresAtSec: number): Promise<boolean>;

  /**
   * Remove expired nonces from memory/storage.
   */
  pruneExpired(): Promise<number>;

  /**
   * Clear all records (useful for test isolation).
   */
  clear(): Promise<void>;
}

export class MemoryStreamTokenNonceStore implements IStreamTokenNonceStore {
  private readonly nonces: Map<string, number> = new Map(); // nonce -> expiresAtSec

  public async claimNonce(nonce: string, expiresAtSec: number): Promise<boolean> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAtSec < nowSec) {
      // Expired token nonces should not be claimed
      return false;
    }

    if (this.nonces.has(nonce)) {
      return false; // Replay detected
    }

    this.nonces.set(nonce, expiresAtSec);

    // Auto prune if map grows beyond threshold
    if (this.nonces.size > 5000) {
      await this.pruneExpired();
    }

    return true;
  }

  public async pruneExpired(): Promise<number> {
    const nowSec = Math.floor(Date.now() / 1000);
    let count = 0;
    for (const [nonce, exp] of this.nonces.entries()) {
      if (exp < nowSec) {
        this.nonces.delete(nonce);
        count++;
      }
    }
    return count;
  }

  public async clear(): Promise<void> {
    this.nonces.clear();
  }

  public size(): number {
    return this.nonces.size;
  }
}
