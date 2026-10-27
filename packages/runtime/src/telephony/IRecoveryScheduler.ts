export interface RecoverySchedulerOptions {
  intervalMs?: number;
  batchSize?: number;
  organizationId?: string;
}

export interface RecoveryExecutionResult {
  reconciledCallIds: string[];
  durationMs: number;
  error?: string;
  timestamp: number;
}

export interface IRecoveryScheduler {
  start(): void;
  stop(): Promise<void>;
  triggerOnce(): Promise<RecoveryExecutionResult>;
  isRunning(): boolean;
}

/**
 * Deterministic test harness and local implementation of IRecoveryScheduler.
 * Wraps any reconciler function (e.g. WalletService.reconcileTerminalCallReservations)
 * with bounded batch execution, overlapping lock prevention, and failure observability.
 */
export class ManualRecoverySchedulerHarness implements IRecoveryScheduler {
  private running = false;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly organizationId?: string;
  private readonly reconcilerFn: (batchSize: number, orgId?: string) => Promise<string[]>;

  constructor(
    reconcilerFn: (batchSize: number, orgId?: string) => Promise<string[]>,
    options: RecoverySchedulerOptions = {}
  ) {
    this.reconcilerFn = reconcilerFn;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.batchSize = options.batchSize ?? 50;
    this.organizationId = options.organizationId;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(async () => {
      try {
        await this.triggerOnce();
      } catch {
        // Scheduled errors captured in triggerOnce
      }
    }, this.intervalMs);
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Deterministically execute a single recovery sweep.
   * Concurrency-safe: prevents overlapping execution passes if a previous pass is in flight.
   */
  public async triggerOnce(): Promise<RecoveryExecutionResult> {
    if (this.inFlight) {
      return {
        reconciledCallIds: [],
        durationMs: 0,
        error: 'OVERLAPPING_EXECUTION_SKIPPED',
        timestamp: Date.now(),
      };
    }

    this.inFlight = true;
    const start = Date.now();

    try {
      const reconciled = await this.reconcilerFn(this.batchSize, this.organizationId);
      const durationMs = Date.now() - start;
      return {
        reconciledCallIds: reconciled || [],
        durationMs,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      return {
        reconciledCallIds: [],
        durationMs,
        error: err.message || 'RECOVERY_EXECUTION_FAILED',
        timestamp: Date.now(),
      };
    } finally {
      this.inFlight = false;
    }
  }
}
