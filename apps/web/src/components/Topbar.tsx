'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface TopbarProps {
  onOpenWallet: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({ onOpenWallet }) => {
  const { user, organization, wallet, logout } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const orgInitial = organization?.name ? organization.name.charAt(0).toUpperCase() : 'A';
  const availableCredits = wallet?.availableCredits ?? 0;

  return (
    <header className="topbar">
      <div className="search-box">
        <span className="search-icon">🔍</span>
        <input
          type="text"
          className="search-input"
          placeholder="Search employees, pages... (Cmd+K)"
        />
      </div>

      <div className="topbar-actions">
        <div
          className="telemetry-pill"
          title="Telephony Engine: Ready. Mock adapter active."
        >
          <span>●</span>
          <span>0 active calls · 0.0 min (Ready)</span>
        </div>

        <div
          className="wallet-pill"
          onClick={onOpenWallet}
          title="Click to view ledger and add credits"
          role="button"
          tabIndex={0}
        >
          <span>💳</span>
          <span>₹{availableCredits.toFixed(2)} credits</span>
          <span className="wallet-add">+</span>
        </div>

        <div
          className="user-profile"
          ref={dropdownRef}
          style={{ position: 'relative' }}
          onClick={() => setDropdownOpen((prev) => !prev)}
          role="button"
          tabIndex={0}
        >
          <div className="user-avatar">{orgInitial}</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 700 }}>
              {organization?.name || 'My Organization'}
            </span>
            <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
              {user?.email || 'user@auris.local'}
            </span>
          </div>

          {dropdownOpen && (
            <div className="user-menu-dropdown" onClick={(e) => e.stopPropagation()}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', marginBottom: 4 }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-main)' }}>
                  {user?.name || 'Administrator'}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Role: {user?.role || 'OWNER'}
                </div>
              </div>

              <button
                type="button"
                className="dropdown-item"
                onClick={() => {
                  setDropdownOpen(false);
                  onOpenWallet();
                }}
              >
                <span>💳</span> Wallet & Billing
              </button>

              <button
                type="button"
                className="dropdown-item danger"
                onClick={() => {
                  setDropdownOpen(false);
                  logout();
                }}
              >
                <span>🚪</span> Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
