'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { AuthView } from '../components/AuthView';
import { Topbar } from '../components/Topbar';
import { Sidebar, NavigationTab } from '../components/Sidebar';
import { AgentBuilder } from '../components/AgentBuilder';
import { AgentList } from '../components/AgentList';
import { WalletModal } from '../components/WalletModal';
import { Agent, agentsApi } from '../lib/api';

export default function DashboardPage() {
  const { isAuthenticated, isLoading: authLoading, organization, wallet } = useAuth();

  const [activeTab, setActiveTab] = useState<NavigationTab>('overview');
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    if (!organization?.id) return;
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const data = await agentsApi.list(organization.id);
      setAgents(data);
    } catch (err: any) {
      console.error('Failed to fetch agents:', err);
      setAgentsError(err.message || 'Unable to load agents.');
    } finally {
      setAgentsLoading(false);
    }
  }, [organization?.id]);

  useEffect(() => {
    if (isAuthenticated && organization?.id) {
      fetchAgents();
    }
  }, [isAuthenticated, organization?.id, fetchAgents]);

  const handleAgentCreated = (newAgent: Agent) => {
    setAgents((prev) => [newAgent, ...prev]);
    // Optional: switch to employees view or stay on overview
  };

  // Auth Loading Screen
  if (authLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0d081f',
          color: '#ffffff',
        }}
      >
        <div style={{ fontSize: '2rem', fontWeight: 900, marginBottom: 12 }}>
          AURIS<span style={{ color: '#a855f7' }}>.</span>
        </div>
        <span
          className="spinner"
          style={{ width: 28, height: 28, borderColor: 'rgba(168, 85, 247, 0.3)', borderTopColor: '#a855f7' }}
        />
        <p style={{ marginTop: 14, fontSize: '0.85rem', color: '#94a3b8' }}>
          Connecting to Auris Control Plane...
        </p>
      </div>
    );
  }

  // Unauthenticated View
  if (!isAuthenticated) {
    return <AuthView />;
  }

  return (
    <div className="app-container">
      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={(tab) => {
          if (tab === 'billing') {
            setWalletModalOpen(true);
          } else {
            setActiveTab(tab);
          }
        }}
        employeeCount={agents.length}
      />

      {/* Main Content Area */}
      <div className="main-wrapper">
        <Topbar onOpenWallet={() => setWalletModalOpen(true)} />

        <main className="content-area">
          {agentsError && (
            <div className="alert-box alert-error" style={{ marginBottom: 20 }}>
              <span>⚠️</span>
              <span>{agentsError}</span>
            </div>
          )}

          {/* OVERVIEW TAB */}
          {activeTab === 'overview' && (
            <>
              {/* Notice Banner */}
              <div className="top-banner">
                <div className="banner-left">
                  <span>📞</span>
                  <div>
                    <strong>Welcome to {organization?.name}</strong>
                    <span style={{ marginLeft: 6, color: '#78350f' }}>
                      {agents.length === 0
                        ? 'Build your first AI employee in less than three minutes.'
                        : `You have ${agents.length} active employee${agents.length > 1 ? 's' : ''} configured.`}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-banner-action"
                  onClick={() => {
                    const builderEl = document.getElementById('ai-builder-section');
                    builderEl?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  {agents.length === 0 ? 'Start Building' : 'Manage Team'}
                </button>
              </div>

              {/* Dark AI Builder Hero Card */}
              <div id="ai-builder-section">
                <AgentBuilder onAgentCreated={handleAgentCreated} />
              </div>

              {/* Quick Actions Grid */}
              <div className="section-title">Quick Actions</div>
              <div className="quick-actions-grid">
                <button
                  type="button"
                  className="action-card"
                  onClick={() => setActiveTab('builder')}
                  style={{ textAlign: 'left', background: 'var(--bg-surface)', cursor: 'pointer' }}
                >
                  <div className="action-card-icon">👤</div>
                  <div>
                    <div className="action-card-title">New employee</div>
                    <div className="action-card-subtitle">Add an AI teammate</div>
                  </div>
                </button>

                <button
                  type="button"
                  className="action-card"
                  onClick={() => setWalletModalOpen(true)}
                  style={{ textAlign: 'left', background: 'var(--bg-surface)', cursor: 'pointer' }}
                >
                  <div className="action-card-icon">💳</div>
                  <div>
                    <div className="action-card-title">Add credits</div>
                    <div className="action-card-subtitle">
                      ₹{wallet?.availableCredits ? wallet.availableCredits.toFixed(2) : '0.00'} balance
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  className="action-card"
                  onClick={() => setActiveTab('employees')}
                  style={{ textAlign: 'left', background: 'var(--bg-surface)', cursor: 'pointer' }}
                >
                  <div className="action-card-icon">👥</div>
                  <div>
                    <div className="action-card-title">My Employees</div>
                    <div className="action-card-subtitle">
                      {agents.length} employee{agents.length === 1 ? '' : 's'} live
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  className="action-card"
                  onClick={() => setWalletModalOpen(true)}
                  style={{ textAlign: 'left', background: 'var(--bg-surface)', cursor: 'pointer' }}
                >
                  <div className="action-card-icon">📋</div>
                  <div>
                    <div className="action-card-title">Ledger & History</div>
                    <div className="action-card-subtitle">View recent deductions</div>
                  </div>
                </button>
              </div>

              {/* AI Employees Section */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="section-title" style={{ marginBottom: 0 }}>
                  Your AI Employees ({agents.length})
                </div>
                {agents.length > 0 && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setActiveTab('employees')}
                  >
                    View All →
                  </button>
                )}
              </div>

              <AgentList
                agents={agents}
                isLoading={agentsLoading}
                onRefresh={fetchAgents}
                onNavigateToBuilder={() => {
                  const builderEl = document.getElementById('ai-builder-section');
                  builderEl?.scrollIntoView({ behavior: 'smooth' });
                }}
              />
            </>
          )}

          {/* EMPLOYEES TAB */}
          {activeTab === 'employees' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <div>
                  <h1 style={{ fontSize: '1.4rem', fontWeight: 800 }}>My AI Employees</h1>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Manage voice personas, update system prompts, and monitor team status.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-build-employee"
                  onClick={() => setActiveTab('builder')}
                >
                  + Hire New Employee
                </button>
              </div>

              <AgentList
                agents={agents}
                isLoading={agentsLoading}
                onRefresh={fetchAgents}
                onNavigateToBuilder={() => setActiveTab('builder')}
              />
            </div>
          )}

          {/* BUILDER TAB */}
          {activeTab === 'builder' && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <h1 style={{ fontSize: '1.4rem', fontWeight: 800 }}>Configure New AI Employee</h1>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Define language, voice parameters, and procedural prompt behavior.
                </p>
              </div>

              <AgentBuilder
                onAgentCreated={(newAgent) => {
                  handleAgentCreated(newAgent);
                  setActiveTab('employees');
                }}
              />
            </div>
          )}
        </main>
      </div>

      {/* Wallet Modal */}
      <WalletModal
        isOpen={walletModalOpen}
        onClose={() => setWalletModalOpen(false)}
      />
    </div>
  );
}
