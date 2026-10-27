-- AlterTable: Add unpaid_amount to wallet_reservations
ALTER TABLE "wallet_reservations" ADD COLUMN "unpaid_amount" DECIMAL(12,4) NOT NULL DEFAULT 0.0000;

-- Database Invariant: Wallets balance_credits must NEVER be negative
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balance_credits_non_negative" CHECK ("balance_credits" >= 0);

-- Database Invariant: Wallets reserved_credits must NEVER be negative
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_reserved_credits_non_negative" CHECK ("reserved_credits" >= 0);

-- Database Invariant: Wallet reservations must have positive reserved amounts
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_reserved_amount_positive" CHECK ("reserved_amount" > 0);

-- Database Invariant: Wallet reservations unpaid_amount must be non-negative
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_unpaid_amount_non_negative" CHECK ("unpaid_amount" >= 0);
