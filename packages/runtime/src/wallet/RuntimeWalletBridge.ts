export interface IWalletManager {
  createReservation(params: {
    organizationId: string;
    callId: string;
    amountCredits: number;
    idempotencyKey?: string;
    holdDurationMinutes?: number;
  }): Promise<any>;

  extendReservation(params: {
    callId: string;
    additionalCredits: number;
    organizationId?: string;
    idempotencyKey?: string;
  }): Promise<{ extended: boolean; action?: string; reason?: string; totalReserved?: number }>;

  settleCall(params: {
    callId: string;
    durationSeconds: number;
    ratePerMinute: number;
    billingBlockSeconds?: number;
    idempotencyKey?: string;
    organizationId?: string;
  }): Promise<any>;

  releaseReservation(params: {
    callId: string;
    reason?: string;
    organizationId?: string;
  }): Promise<any>;
}

export interface WalletBridgeConfig {
  organizationId: string;
  callId: string;
  voiceTier: 'STANDARD' | 'PREMIUM' | 'ULTRA';
  customRatePerMinute?: number;
  billingBlockSeconds?: number;
}

export class RuntimeWalletBridge {
  private readonly ratePerMinute: number;
  private readonly billingBlockSeconds: number;
  private isSettled = false;
  private isReleased = false;
  private settlementPromise: Promise<{ settled: boolean; amount: number }> | null = null;

  constructor(
    private readonly walletManager: IWalletManager,
    private readonly config: WalletBridgeConfig
  ) {
    if (config.customRatePerMinute !== undefined && config.customRatePerMinute > 0) {
      this.ratePerMinute = config.customRatePerMinute;
    } else {
      switch (config.voiceTier) {
        case 'PREMIUM':
          this.ratePerMinute = 7.50;
          break;
        case 'ULTRA':
          this.ratePerMinute = 10.00;
          break;
        case 'STANDARD':
        default:
          this.ratePerMinute = 5.00;
          break;
      }
    }
    this.billingBlockSeconds = config.billingBlockSeconds ?? 30;
  }

  getRatePerMinute(): number {
    return this.ratePerMinute;
  }

  /**
   * Acquire atomic pre-authorization hold before dialing/answering carrier.
   * Throws INSUFFICIENT_FUNDS if wallet available credits are lower than required hold.
   */
  async acquirePreAuthHold(durationMinutes: number = 1): Promise<{ reservedAmount: number }> {
    const amountCredits = Number((this.ratePerMinute * durationMinutes).toFixed(4));
    const idempotencyKey = `preauth:${this.config.callId}`;

    await this.walletManager.createReservation({
      organizationId: this.config.organizationId,
      callId: this.config.callId,
      amountCredits,
      idempotencyKey,
      holdDurationMinutes: 60,
    });

    return { reservedAmount: amountCredits };
  }

  /**
   * Mid-call lease extension.
   * If insufficient funds, returns { terminate: true } to prevent carrier overdraft.
   */
  async extendHold(additionalMinutes: number = 1): Promise<{ extended: boolean; terminate: boolean }> {
    const additionalCredits = Number((this.ratePerMinute * additionalMinutes).toFixed(4));
    const idempotencyKey = `extend:${this.config.callId}:${Date.now()}`;

    const result = await this.walletManager.extendReservation({
      callId: this.config.callId,
      additionalCredits,
      organizationId: this.config.organizationId,
      idempotencyKey,
    });

    if (!result.extended && result.action === 'TERMINATE_CALL') {
      return { extended: false, terminate: true };
    }

    return { extended: true, terminate: false };
  }

  /**
   * Final settlement on call termination.
   * Idempotent: safe against duplicate carrier callbacks or repeated hangup events.
   */
  async finalizeSettlement(durationSeconds: number, answered: boolean, reason?: string): Promise<{ settled: boolean; amount: number }> {
    // If already finalized, safe no-op
    if (this.isSettled || this.isReleased) {
      return { settled: this.isSettled, amount: 0 };
    }

    if (this.settlementPromise) {
      return this.settlementPromise;
    }

    this.settlementPromise = (async () => {
      try {
        if (!answered) {
          // Unanswered, busy, or failed before connection -> release hold without charge
          await this.walletManager.releaseReservation({
            callId: this.config.callId,
            reason: reason || 'Call not answered or connected',
            organizationId: this.config.organizationId,
          });
          this.isReleased = true;
          return { settled: false, amount: 0 };
        }

        // Answered call -> atomic settlement with idempotency key
        const effectiveDuration = Math.max(1, durationSeconds);
        const idempotencyKey = `settle:${this.config.callId}`;

        const settlement = await this.walletManager.settleCall({
          callId: this.config.callId,
          durationSeconds: effectiveDuration,
          ratePerMinute: this.ratePerMinute,
          billingBlockSeconds: this.billingBlockSeconds,
          idempotencyKey,
          organizationId: this.config.organizationId,
        });

        this.isSettled = true;
        return {
          settled: true,
          amount: settlement.settledAmount ?? settlement.totalCost ?? 0,
        };
      } finally {
        this.settlementPromise = null;
      }
    })();

    return this.settlementPromise;
  }
}
