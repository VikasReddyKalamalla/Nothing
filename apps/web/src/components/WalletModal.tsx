'use client';

import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { walletsApi } from '../lib/api';

interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WalletModal: React.FC<WalletModalProps> = ({ isOpen, onClose }) => {
  const { wallet, organization, refreshWallet } = useAuth();

  const [topUpAmount, setTopUpAmount] = useState<number>(500);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  if (!isOpen) return null;

  const quickAmounts = [100, 500, 1000, 2500];

  const handleSelectQuickAmount = (amount: number) => {
    setTopUpAmount(amount);
    setCustomAmount('');
    setErrorNotice(null);
  };

  const handleCustomAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setCustomAmount(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed > 0) {
      setTopUpAmount(parsed);
    }
    setErrorNotice(null);
  };

  const handleTopUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorNotice(null);
    setSuccessNotice(null);

    if (!organization?.id) {
      setErrorNotice('No active organization identified.');
      return;
    }

    const amount = customAmount ? parseFloat(customAmount) : topUpAmount;
    if (isNaN(amount) || amount <= 0) {
      setErrorNotice('Top-up amount must be a positive number.');
      return;
    }

    setIsSubmitting(true);
    try {
      const idempotencyKey = `web-topup-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const result = await walletsApi.topUp(organization.id, {
        amountCredits: amount,
        idempotencyKey,
        description: `Simulated Demo Top-Up (₹${amount.toFixed(2)})`,
      });

      setSuccessNotice(`Simulated recharge of ₹${amount.toFixed(2)} successful! New balance: ₹${result.newBalance.toFixed(2)} (No real funds charged)`);
      await refreshWallet();
      setCustomAmount('');
    } catch (err: any) {
      setErrorNotice(err.message || 'Top-up failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const available = wallet?.availableCredits ?? 0;
  const reserved = wallet?.reservedCredits ?? 0;
  const balance = wallet?.balanceCredits ?? 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 className="modal-title">Wallet & Telephony Credits</h3>
              <span
                style={{
                  background: '#fef3c7',
                  color: '#92400e',
                  fontSize: '0.68rem',
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}
              >
                SIMULATED / DEMO MODE
              </span>
            </div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              1 Credit = ₹1.00 INR · Dedicated to voice calling & AI runtime
            </span>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {errorNotice && (
            <div className="alert-box alert-error">
              <span>⚠️</span>
              <span>{errorNotice}</span>
            </div>
          )}

          {successNotice && (
            <div className="alert-box alert-success">
              <span>✅</span>
              <span>{successNotice}</span>
            </div>
          )}

          <div
            style={{
              backgroundColor: '#f1f5f9',
              border: '1px solid #cbd5e1',
              color: '#334155',
              padding: '8px 12px',
              borderRadius: 8,
              fontSize: '0.78rem',
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>ℹ️</span>
            <span>
              <strong>Simulated Environment:</strong> Payment gateway integrations are disabled in Phase 2. Top-ups create simulated platform test credits and do not charge real bank accounts or cards.
            </span>
          </div>

          {available <= 50 && (
            <div
              style={{
                backgroundColor: '#fffbeb',
                border: '1px solid #fde68a',
                color: '#92400e',
                padding: '10px 14px',
                borderRadius: 8,
                fontSize: '0.82rem',
                marginBottom: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>⚡</span>
              <span>
                <strong>Low Balance Alert:</strong> Available balance is below ₹50.00. Recharge to prevent automated call interruptions.
              </span>
            </div>
          )}

          {/* Balance Cards Summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
            <div
              style={{
                backgroundColor: '#f8fafc',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                padding: 16,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                AVAILABLE CREDITS
              </div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#059669' }}>
                ₹{available.toFixed(2)}
              </div>
            </div>

            <div
              style={{
                backgroundColor: '#f8fafc',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                padding: 16,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                ACTIVE HOLDS
              </div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#d97706' }}>
                ₹{reserved.toFixed(2)}
              </div>
            </div>

            <div
              style={{
                backgroundColor: '#f8fafc',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                padding: 16,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                TOTAL BALANCE
              </div>
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-main)' }}>
                ₹{balance.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Recharge Section */}
          <div
            style={{
              backgroundColor: '#fafbfc',
              border: '1px solid var(--border-subtle)',
              borderRadius: 12,
              padding: 20,
              marginBottom: 24,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h4 style={{ fontSize: '0.92rem', fontWeight: 700 }}>
                Simulate Credit Top-Up
              </h4>
              <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                Instant test recharge
              </span>
            </div>

            <form onSubmit={handleTopUpSubmit} noValidate>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                {quickAmounts.map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    className={`btn-secondary ${topUpAmount === amt && !customAmount ? 'active' : ''}`}
                    style={{
                      borderColor: topUpAmount === amt && !customAmount ? 'var(--primary)' : undefined,
                      backgroundColor: topUpAmount === amt && !customAmount ? 'var(--primary-light)' : undefined,
                      color: topUpAmount === amt && !customAmount ? 'var(--primary)' : undefined,
                    }}
                    onClick={() => handleSelectQuickAmount(amt)}
                  >
                    +₹{amt}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  type="number"
                  className="form-input-light"
                  placeholder="Or enter custom amount in ₹"
                  value={customAmount}
                  onChange={handleCustomAmountChange}
                  min="1"
                  step="1"
                  disabled={isSubmitting}
                />
                <button
                  type="submit"
                  className="btn-primary"
                  style={{ width: 'auto', minWidth: 200, padding: '0 20px' }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <span className="spinner" /> Recharging...
                    </>
                  ) : (
                    `⚡ Add ₹${customAmount ? parseFloat(customAmount || '0').toFixed(2) : topUpAmount.toFixed(2)} (Simulated)`
                  )}
                </button>
              </div>
            </form>
          </div>

          {/* Transaction Ledger Table */}
          <div>
            <h4 style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 12 }}>
              Recent Transactions Ledger
            </h4>

            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date & Time</th>
                    <th>Description</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {wallet?.recentTransactions && wallet.recentTransactions.length > 0 ? (
                    wallet.recentTransactions.map((tx) => {
                      const amount = Number(tx.amountCredits);
                      const isPositive = amount > 0;
                      return (
                        <tr key={tx.id}>
                          <td style={{ whiteSpace: 'nowrap', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {new Date(tx.createdAt).toLocaleString('en-IN', {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            })}
                          </td>
                          <td style={{ maxWidth: 220 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>
                              {tx.description || tx.referenceId || 'Transaction'}
                            </div>
                          </td>
                          <td>
                            <span
                              style={{
                                fontSize: '0.7rem',
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: 4,
                                backgroundColor: tx.type === 'TOPUP' ? '#ecfdf5' : '#f1f5f9',
                                color: tx.type === 'TOPUP' ? '#059669' : '#475569',
                              }}
                            >
                              {tx.type}
                            </span>
                          </td>
                          <td className={isPositive ? 'amount-positive' : 'amount-negative'}>
                            {isPositive ? `+₹${amount.toFixed(2)}` : `-₹${Math.abs(amount).toFixed(2)}`}
                          </td>
                          <td style={{ fontWeight: 600 }}>
                            ₹{Number(tx.balanceAfter).toFixed(2)}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--text-muted)' }}>
                        No transactions recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
