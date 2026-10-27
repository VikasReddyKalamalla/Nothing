'use client';

import React from 'react';
import { useAuth } from '../contexts/AuthContext';

export type NavigationTab = 'overview' | 'employees' | 'builder' | 'billing';

interface SidebarProps {
  activeTab: NavigationTab;
  onTabChange: (tab: NavigationTab) => void;
  employeeCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  employeeCount,
}) => {
  const { logout } = useAuth();

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="logo-container">
          <span className="logo-text">
            AURIS<span className="logo-dot">.</span>
          </span>
        </div>
        <span
          style={{ fontSize: '0.75rem', color: '#94a3b8', cursor: 'pointer' }}
          title="Voice Control Plane"
        >
          ◫
        </span>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section-title">Overview</div>
        <button
          type="button"
          className={`nav-item ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => onTabChange('overview')}
        >
          <span>📊</span> Dashboard
        </button>
        <button
          type="button"
          className={`nav-item ${activeTab === 'employees' ? 'active' : ''}`}
          onClick={() => onTabChange('employees')}
        >
          <span>👥</span> My Employees
          {employeeCount > 0 && <span className="nav-badge">{employeeCount}</span>}
        </button>
        <button
          type="button"
          className={`nav-item ${activeTab === 'builder' ? 'active' : ''}`}
          onClick={() => onTabChange('builder')}
        >
          <span>➕</span> New employee
        </button>

        <div className="nav-section-title">Calling Channels</div>
        <button
          type="button"
          className="nav-item"
          onClick={() => onTabChange('builder')}
        >
          <span>⚡</span> Instant Leads
        </button>
        <button
          type="button"
          className="nav-item"
          onClick={() => onTabChange('builder')}
        >
          <span>📢</span> Bulk Campaigns
        </button>
        <button
          type="button"
          className="nav-item"
          onClick={() => onTabChange('builder')}
        >
          <span>📞</span> Inbound Receptionist <span className="nav-badge">NEW</span>
        </button>

        <div className="nav-section-title">Finance & Setup</div>
        <button
          type="button"
          className={`nav-item ${activeTab === 'billing' ? 'active' : ''}`}
          onClick={() => onTabChange('billing')}
        >
          <span>💳</span> Billing & Credits
        </button>
        <button
          type="button"
          className="nav-item"
          onClick={logout}
          style={{ color: '#dc2626' }}
        >
          <span>🚪</span> Log out
        </button>
      </nav>

      <div className="sidebar-footer">
        <div className="team-status-box">
          <span>Your team</span>
          <span className="team-pill">{employeeCount} active</span>
        </div>
        <div className="footer-links">
          <a href="#" onClick={(e) => e.preventDefault()}>
            Docs
          </a>{' '}
          ·{' '}
          <a href="#" onClick={(e) => e.preventDefault()}>
            Terms
          </a>{' '}
          ·{' '}
          <a href="#" onClick={(e) => e.preventDefault()}>
            Security
          </a>
        </div>
      </div>
    </aside>
  );
};
