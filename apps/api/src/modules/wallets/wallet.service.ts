import { PrismaClient, Prisma, WalletTxType, ReservationStatus } from '@auris/database';

export interface CreateReservationParams {
  organizationId: string;
  callId: string;
  amountCredits: number;
  idempotencyKey?: string;
  holdDurationMinutes?: number;
}

export interface SettleCallParams {
  callId: string;
  durationSeconds: number;
  ratePerMinute: number;
  billingBlockSeconds?: number;
  idempotencyKey?: string;
  organizationId?: string;
}

export interface ExtendReservationParams {
  callId: string;
  additionalCredits: number;
  organizationId?: string;
  idempotencyKey?: string;
}

export interface ReleaseReservationParams {
  callId: string;
  reason?: string;
  organizationId?: string;
}

export interface TopUpWalletParams {
  organizationId: string;
  amountCredits: number;
  referenceId?: string;
  idempotencyKey: string;
  description?: string;
}

export class WalletService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Calculate billable units and total charge.
   * Standard block: 30s. E.g., 24s -> 30s; 31s -> 60s.
   */
  static calculateCallCharge(
    durationSeconds: number,
    ratePerMinute: number,
    billingBlockSeconds = 30
  ): { billableSeconds: number; chargeAmount: number } {
    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      !Number.isFinite(ratePerMinute) ||
      ratePerMinute <= 0
    ) {
      return { billableSeconds: 0, chargeAmount: 0 };
    }
    const blocks = Math.ceil(durationSeconds / billingBlockSeconds);
    const billableSeconds = blocks * billingBlockSeconds;
    const chargeAmount = Number(((billableSeconds / 60) * ratePerMinute).toFixed(4));
    return { billableSeconds, chargeAmount };
  }

  /**
   * Atomically reserve funds for a call before carrier initiation.
   * Uses raw SQL with row-level locking (SELECT ... FOR UPDATE) to eliminate race conditions.
   */
  async createReservation(params: CreateReservationParams) {
    const { organizationId, callId, amountCredits, holdDurationMinutes = 60 } = params;

    if (amountCredits <= 0) {
      throw new Error('RESERVATION_AMOUNT_MUST_BE_POSITIVE');
    }

    return await this.prisma.$transaction(
      async (tx) => {
        // Check for existing reservation (idempotency)
        const existing = await tx.walletReservation.findUnique({
          where: { callId },
        });
        if (existing) {
          return existing;
        }

        // Lock wallet row for update
        const wallets = await tx.$queryRaw<
          Array<{
            id: string;
            organization_id: string;
            balance_credits: Prisma.Decimal;
            reserved_credits: Prisma.Decimal;
          }>
        >`SELECT id, organization_id, balance_credits, reserved_credits 
          FROM wallets 
          WHERE organization_id = ${organizationId}::uuid 
          FOR UPDATE`;

        if (!wallets || wallets.length === 0) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const wallet = wallets[0];
        const balance = Number(wallet.balance_credits);
        const reserved = Number(wallet.reserved_credits);
        const available = balance - reserved;

        if (available < amountCredits) {
          throw new Error('INSUFFICIENT_FUNDS');
        }

        // Apply hold to wallet
        const newReserved = reserved + amountCredits;
        await tx.$executeRaw`
          UPDATE wallets 
          SET reserved_credits = ${newReserved}, updated_at = NOW() 
          WHERE id = ${wallet.id}::uuid
        `;

        const expiresAt = new Date(Date.now() + holdDurationMinutes * 60 * 1000);

        // Record reservation
        const reservation = await tx.walletReservation.create({
          data: {
            walletId: wallet.id,
            callId,
            reservedAmount: new Prisma.Decimal(amountCredits),
            status: ReservationStatus.HELD,
            expiresAt,
          },
        });

        // Audit hold in transactions
        const idempotencyKey = params.idempotencyKey || `hold:${callId}`;
        await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            amountCredits: new Prisma.Decimal(0),
            balanceAfter: new Prisma.Decimal(balance - newReserved),
            type: WalletTxType.CALL_HOLD,
            referenceId: callId,
            idempotencyKey,
            description: `Pre-authorization hold of ₹${amountCredits} for call ${callId}`,
          },
        });

        return reservation;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }
    );
  }

  /**
   * Atomically extend a call reservation mid-call.
   * If sufficient funds exist, the hold is extended.
   * If insufficient funds exist, returns action: 'TERMINATE_CALL' to safely restrict or terminate the call before carrier overdraft.
   */
  async extendReservation(params: ExtendReservationParams) {
    const { callId, additionalCredits, organizationId } = params;

    if (additionalCredits <= 0) {
      throw new Error('ADDITIONAL_AMOUNT_MUST_BE_POSITIVE');
    }

    return await this.prisma.$transaction(
      async (tx) => {
        // Lock reservation row
        const reservations = await tx.$queryRaw<
          Array<{
            id: string;
            wallet_id: string;
            call_id: string;
            reserved_amount: Prisma.Decimal;
            status: ReservationStatus;
          }>
        >`SELECT id, wallet_id, call_id, reserved_amount, status 
          FROM wallet_reservations 
          WHERE call_id = ${callId} 
          FOR UPDATE`;

        if (!reservations || reservations.length === 0) {
          throw new Error('RESERVATION_NOT_FOUND');
        }

        const reservation = reservations[0];
        if (reservation.status !== ReservationStatus.HELD) {
          throw new Error('CANNOT_EXTEND_NON_HELD_RESERVATION');
        }

        // Lock wallet row
        const wallets = await tx.$queryRaw<
          Array<{
            id: string;
            organization_id: string;
            balance_credits: Prisma.Decimal;
            reserved_credits: Prisma.Decimal;
          }>
        >`SELECT id, organization_id, balance_credits, reserved_credits 
          FROM wallets 
          WHERE id = ${reservation.wallet_id}::uuid 
          FOR UPDATE`;

        if (!wallets || wallets.length === 0) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const wallet = wallets[0];

        if (organizationId && wallet.organization_id !== organizationId) {
          throw new Error('CROSS_TENANT_ACCESS_DENIED');
        }

        const balance = Number(wallet.balance_credits);
        const currentReserved = Number(wallet.reserved_credits);
        const available = balance - currentReserved;

        if (available < additionalCredits) {
          return {
            extended: false,
            callId,
            action: 'TERMINATE_CALL',
            reason: 'INSUFFICIENT_FUNDS_FOR_EXTENSION',
            availableCredits: available,
            currentReserved: Number(reservation.reserved_amount),
          };
        }

        const newReserved = Number((currentReserved + additionalCredits).toFixed(4));
        const newReservationAmount = Number((Number(reservation.reserved_amount) + additionalCredits).toFixed(4));

        await tx.$executeRaw`
          UPDATE wallets 
          SET reserved_credits = ${newReserved}, updated_at = NOW() 
          WHERE id = ${wallet.id}::uuid
        `;

        await tx.walletReservation.update({
          where: { id: reservation.id },
          data: {
            reservedAmount: new Prisma.Decimal(newReservationAmount),
          },
        });

        const idempotencyKey = params.idempotencyKey || `extend:${callId}:${Date.now()}`;
        await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            amountCredits: new Prisma.Decimal(0),
            balanceAfter: new Prisma.Decimal(balance - newReserved),
            type: WalletTxType.CALL_HOLD,
            referenceId: callId,
            idempotencyKey,
            description: `Extended hold by ₹${additionalCredits} for active call ${callId}`,
          },
        });

        return {
          extended: true,
          callId,
          totalReserved: newReservationAmount,
          availableCredits: Number((balance - newReserved).toFixed(4)),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }
    );
  }

  /**
   * Settle a call upon termination.
   * Deducts the actual charge from balance_credits, releases the hold from reserved_credits.
   */
  async settleCall(params: SettleCallParams) {
    const { callId, durationSeconds, ratePerMinute, billingBlockSeconds = 30 } = params;

    const { billableSeconds, chargeAmount } = WalletService.calculateCallCharge(
      durationSeconds,
      ratePerMinute,
      billingBlockSeconds
    );

    return await this.prisma.$transaction(
      async (tx) => {
        // Lock reservation row
        const reservations = await tx.$queryRaw<
          Array<{
            id: string;
            wallet_id: string;
            call_id: string;
            reserved_amount: Prisma.Decimal;
            settled_amount: Prisma.Decimal | null;
            status: ReservationStatus;
          }>
        >`SELECT id, wallet_id, call_id, reserved_amount, settled_amount, status 
          FROM wallet_reservations 
          WHERE call_id = ${callId} 
          FOR UPDATE`;

        if (!reservations || reservations.length === 0) {
          throw new Error('RESERVATION_NOT_FOUND');
        }

        const reservation = reservations[0];

        // Idempotency check: If already settled, return existing settlement
        if (reservation.status === ReservationStatus.SETTLED) {
          return {
            callId,
            status: 'ALREADY_SETTLED',
            billableSeconds,
            settledAmount: Number(reservation.settled_amount),
          };
        }

        if (reservation.status === ReservationStatus.CANCELLED) {
          throw new Error('RESERVATION_ALREADY_CANCELLED');
        }

        const reservedAmount = Number(reservation.reserved_amount);

        // Lock wallet row
        const wallets = await tx.$queryRaw<
          Array<{
            id: string;
            organization_id: string;
            balance_credits: Prisma.Decimal;
            reserved_credits: Prisma.Decimal;
          }>
        >`SELECT id, organization_id, balance_credits, reserved_credits 
          FROM wallets 
          WHERE id = ${reservation.wallet_id}::uuid 
          FOR UPDATE`;

        if (!wallets || wallets.length === 0) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const wallet = wallets[0];

        // Strict cross-tenant access verification
        if (params.organizationId && wallet.organization_id !== params.organizationId) {
          throw new Error('CROSS_TENANT_ACCESS_DENIED');
        }

        const currentBalance = Number(wallet.balance_credits);
        const currentReserved = Number(wallet.reserved_credits);

        // Financial Invariant: Balance must NEVER go below 0.0000.
        // If actual charge exceeds total balance, charge is capped at total balance.
        let actualCharge = chargeAmount;
        let isOverdraft = false;

        if (chargeAmount > currentBalance) {
          actualCharge = Math.max(0, currentBalance);
          isOverdraft = true;
        }

        const newBalance = Number(Math.max(0, currentBalance - actualCharge).toFixed(4));
        const newReserved = Number(Math.max(0, currentReserved - reservedAmount).toFixed(4));

        await tx.$executeRaw`
          UPDATE wallets 
          SET balance_credits = ${newBalance},
              reserved_credits = ${newReserved},
              updated_at = NOW() 
          WHERE id = ${wallet.id}::uuid
        `;

        const unpaidAmount = isOverdraft ? Number((chargeAmount - actualCharge).toFixed(4)) : 0;

        await tx.walletReservation.update({
          where: { id: reservation.id },
          data: {
            status: ReservationStatus.SETTLED,
            settledAmount: new Prisma.Decimal(actualCharge),
            unpaidAmount: new Prisma.Decimal(unpaidAmount),
          },
        });

        const idempotencyKey = params.idempotencyKey || `settle:${callId}`;
        const description = isOverdraft
          ? `Partial settlement: ₹${actualCharge} collected from balance. Unpaid provider cost: ₹${unpaidAmount} due to balance exhaustion for call ${callId} (${durationSeconds}s)`
          : `Call settlement: ${durationSeconds}s (${billableSeconds}s billable @ ₹${ratePerMinute}/min)`;

        await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            amountCredits: new Prisma.Decimal(-actualCharge),
            balanceAfter: new Prisma.Decimal(newBalance),
            type: WalletTxType.CALL_SETTLEMENT,
            referenceId: callId,
            idempotencyKey,
            description,
          },
        });

        return {
          callId,
          status: 'SETTLED',
          durationSeconds,
          billableSeconds,
          totalCost: chargeAmount,
          settledAmount: actualCharge,
          unpaidAmount,
          unsettledOverdraft: unpaidAmount,
          isPartialSettlement: isOverdraft,
          newBalance,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }
    );
  }

  /**
   * Release hold without deduction for unanswered, busy, or failed calls.
   */
  async releaseReservation(params: ReleaseReservationParams) {
    const { callId, reason = 'Call not connected' } = params;

    return await this.prisma.$transaction(
      async (tx) => {
        const reservations = await tx.$queryRaw<
          Array<{
            id: string;
            wallet_id: string;
            call_id: string;
            reserved_amount: Prisma.Decimal;
            status: ReservationStatus;
          }>
        >`SELECT id, wallet_id, call_id, reserved_amount, status 
          FROM wallet_reservations 
          WHERE call_id = ${callId} 
          FOR UPDATE`;

        if (!reservations || reservations.length === 0) {
          throw new Error('RESERVATION_NOT_FOUND');
        }

        const reservation = reservations[0];

        if (reservation.status === ReservationStatus.CANCELLED) {
          return { callId, status: 'ALREADY_CANCELLED' };
        }

        if (reservation.status === ReservationStatus.SETTLED) {
          throw new Error('CANNOT_CANCEL_SETTLED_RESERVATION');
        }

        const reservedAmount = Number(reservation.reserved_amount);

        const wallets = await tx.$queryRaw<
          Array<{
            id: string;
            organization_id: string;
            balance_credits: Prisma.Decimal;
            reserved_credits: Prisma.Decimal;
          }>
        >`SELECT id, organization_id, balance_credits, reserved_credits 
          FROM wallets 
          WHERE id = ${reservation.wallet_id}::uuid 
          FOR UPDATE`;

        if (!wallets || wallets.length === 0) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const wallet = wallets[0];

        // Strict cross-tenant access verification
        if (params.organizationId && wallet.organization_id !== params.organizationId) {
          throw new Error('CROSS_TENANT_ACCESS_DENIED');
        }

        const currentBalance = Number(wallet.balance_credits);
        const currentReserved = Number(wallet.reserved_credits);
        const newReserved = Math.max(0, Number((currentReserved - reservedAmount).toFixed(4)));

        await tx.$executeRaw`
          UPDATE wallets 
          SET reserved_credits = ${newReserved}, updated_at = NOW() 
          WHERE id = ${wallet.id}::uuid
        `;

        await tx.walletReservation.update({
          where: { id: reservation.id },
          data: {
            status: ReservationStatus.CANCELLED,
            settledAmount: new Prisma.Decimal(0),
          },
        });

        await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            amountCredits: new Prisma.Decimal(0),
            balanceAfter: new Prisma.Decimal(currentBalance - newReserved),
            type: WalletTxType.CALL_REFUND,
            referenceId: callId,
            idempotencyKey: `release:${callId}`,
            description: `Released hold of ₹${reservedAmount}: ${reason}`,
          },
        });

        return {
          callId,
          status: 'CANCELLED',
          releasedAmount: reservedAmount,
          balance: currentBalance,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }
    );
  }

  /**
   * Top up wallet with credits (1 credit = ₹1).
   */
  async topUpWallet(params: TopUpWalletParams) {
    const { organizationId, amountCredits, referenceId, idempotencyKey, description } = params;

    if (amountCredits <= 0) {
      throw new Error('TOPUP_AMOUNT_MUST_BE_POSITIVE');
    }

    return await this.prisma.$transaction(
      async (tx) => {
        // Check transaction idempotency
        const existingTx = await tx.creditTransaction.findUnique({
          where: { idempotencyKey },
        });
        if (existingTx) {
          return { status: 'ALREADY_PROCESSED', transaction: existingTx };
        }

        const wallets = await tx.$queryRaw<
          Array<{
            id: string;
            balance_credits: Prisma.Decimal;
            reserved_credits: Prisma.Decimal;
          }>
        >`SELECT id, balance_credits, reserved_credits 
          FROM wallets 
          WHERE organization_id = ${organizationId}::uuid 
          FOR UPDATE`;

        if (!wallets || wallets.length === 0) {
          throw new Error('WALLET_NOT_FOUND');
        }

        const wallet = wallets[0];
        const currentBalance = Number(wallet.balance_credits);
        const newBalance = Number((currentBalance + amountCredits).toFixed(4));

        await tx.$executeRaw`
          UPDATE wallets 
          SET balance_credits = ${newBalance}, updated_at = NOW() 
          WHERE id = ${wallet.id}::uuid
        `;

        const transaction = await tx.creditTransaction.create({
          data: {
            walletId: wallet.id,
            amountCredits: new Prisma.Decimal(amountCredits),
            balanceAfter: new Prisma.Decimal(newBalance),
            type: WalletTxType.TOPUP,
            referenceId: referenceId || `topup-${Date.now()}`,
            idempotencyKey,
            description: description || `Wallet top-up of ₹${amountCredits}`,
          },
        });

        return { status: 'SUCCESS', newBalance, transaction };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }
    );
  }

  /**
   * Get real-time wallet balances.
   */
  async getWalletBalance(organizationId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { organizationId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!wallet) {
      throw new Error('WALLET_NOT_FOUND');
    }

    const balance = Number(wallet.balanceCredits);
    const reserved = Number(wallet.reservedCredits);
    const available = Number((balance - reserved).toFixed(4));

    return {
      walletId: wallet.id,
      organizationId: wallet.organizationId,
      currency: wallet.currency,
      balanceCredits: balance,
      reservedCredits: reserved,
      availableCredits: available,
      isLowBalance: available <= Number(wallet.lowBalanceThreshold),
      recentTransactions: wallet.transactions,
    };
  }

  /**
   * Reconcile orphaned or expired holds (e.g. after worker crash or dropped calls).
   * Automatically releases reservations that have passed their expiresAt timestamp.
   */
  async reconcileExpiredReservations(now = new Date()) {
    const expiredReservations = await this.prisma.walletReservation.findMany({
      where: {
        status: ReservationStatus.HELD,
        expiresAt: { lte: now },
      },
      take: 50,
    });

    const results = [];
    for (const res of expiredReservations) {
      try {
        const released = await this.releaseReservation({
          callId: res.callId,
          reason: 'Automated recovery: Reservation hold expired',
        });
        results.push(released);
      } catch (err: any) {
        // Ignored if concurrently settled or released
      }
    }
    return results;
  }

  /**
   * Reconcile orphaned reservations where the underlying Call reached a terminal status
   * (COMPLETED, FAILED, or REJECTED) while the reservation remained HELD
   * (e.g. after worker crash, process exit, or missed runtime settlement).
   */
  async reconcileTerminalCallReservations(limit = 50, organizationId?: string) {
    const candidates = await this.prisma.$queryRaw<
      Array<{
        id: string;
        call_id: string;
        wallet_id: string;
        reserved_amount: Prisma.Decimal;
        status: ReservationStatus;
        expires_at: Date;
        created_at: Date;
        organization_id: string;
        db_call_id: string | null;
        db_call_status: string | null;
        db_duration_seconds: number | null;
        db_started_at: Date | null;
        db_ended_at: Date | null;
      }>
    >`
      SELECT wr.id, wr.call_id, wr.wallet_id, wr.reserved_amount, wr.status, wr.expires_at, wr.created_at, w.organization_id,
             c.id AS db_call_id, c.status::text AS db_call_status, c.duration_seconds AS db_duration_seconds,
             c.started_at AS db_started_at, c.ended_at AS db_ended_at
      FROM wallet_reservations wr
      JOIN wallets w ON w.id = wr.wallet_id
      LEFT JOIN calls c ON c.id::text = wr.call_id
      WHERE wr.status = 'HELD'
        AND (
          c.status::text IN ('COMPLETED', 'FAILED', 'REJECTED', 'BUSY', 'NO_ANSWER')
          OR (c.id IS NULL AND wr.expires_at < NOW())
        )
        ${organizationId ? Prisma.sql`AND w.organization_id = ${organizationId}::uuid` : Prisma.empty}
      ORDER BY wr.created_at ASC
      LIMIT ${limit}
    `;

    const results = [];
    for (const item of candidates) {
      if (!item.db_call_id) {
        // Orphaned reservation with no underlying Call record (expired hold)
        try {
          const released = await this.releaseReservation({
            callId: item.call_id,
            reason: 'Automated recovery: Orphaned reservation with no underlying Call record',
            organizationId: item.organization_id,
          });
          results.push(released);
        } catch (err: any) {}
        continue;
      }

      const duration = (item.db_duration_seconds && item.db_duration_seconds > 0)
        ? item.db_duration_seconds
        : (item.db_started_at && item.db_ended_at && new Date(item.db_ended_at).getTime() > new Date(item.db_started_at).getTime()
            ? Math.round((new Date(item.db_ended_at).getTime() - new Date(item.db_started_at).getTime()) / 1000)
            : 0);

      try {
        if (item.db_call_status === 'COMPLETED' && duration > 0) {
          const settled = await this.settleCall({
            callId: item.call_id,
            durationSeconds: duration,
            ratePerMinute: 6.0,
            organizationId: item.organization_id,
            idempotencyKey: `settle:reconcile:${item.call_id}`,
          });
          results.push(settled);
        } else {
          const released = await this.releaseReservation({
            callId: item.call_id,
            reason: `Automated recovery: Call reached terminal state (${item.db_call_status}) without billable duration`,
            organizationId: item.organization_id,
          });
          results.push(released);
        }
      } catch (err: any) {
        // Concurrency safe: if another worker settled or released it concurrently, ignore
      }
    }
    return results;
  }
}
