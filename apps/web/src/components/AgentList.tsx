'use client';

import React, { useState } from 'react';
import { Agent, agentsApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

interface AgentListProps {
  agents: Agent[];
  isLoading: boolean;
  onRefresh: () => void;
  onNavigateToBuilder: () => void;
}

export const AgentList: React.FC<AgentListProps> = ({
  agents,
  isLoading,
  onRefresh,
  onNavigateToBuilder,
}) => {
  const { organization } = useAuth();
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const handleToggleStatus = async (agent: Agent) => {
    if (!organization?.id) return;
    const newStatus = agent.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setActionInProgress(agent.id);
    setErrorNotice(null);
    try {
      await agentsApi.update(organization.id, agent.id, {
        status: newStatus,
      });
      onRefresh();
    } catch (err: any) {
      setErrorNotice(err.message || 'Failed to toggle status');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDelete = async (agent: Agent) => {
    if (!organization?.id) return;
    if (!window.confirm(`Are you sure you want to terminate/delete AI Employee "${agent.name}"?`)) {
      return;
    }
    setActionInProgress(agent.id);
    setErrorNotice(null);
    try {
      await agentsApi.delete(organization.id, agent.id);
      if (selectedAgent?.id === agent.id) {
        setSelectedAgent(null);
      }
      onRefresh();
    } catch (err: any) {
      setErrorNotice(err.message || 'Failed to delete employee');
    } finally {
      setActionInProgress(null);
    }
  };

  if (isLoading) {
    return (
      <div
        style={{
          padding: '48px 24px',
          textAlign: 'center',
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 12,
          border: '1px solid var(--border-subtle)',
        }}
      >
        <span className="spinner" style={{ borderColor: 'rgba(124, 58, 237, 0.3)', borderTopColor: '#7c3aed', width: 28, height: 28 }} />
        <p style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Loading active AI employees...
        </p>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 14,
          padding: '48px 24px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>👥</div>
        <h3 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: 6 }}>
          Hire your first AI employee
        </h3>
        <p
          style={{
            fontSize: '0.88rem',
            color: 'var(--text-muted)',
            maxWidth: 460,
            margin: '0 auto 20px',
            lineHeight: 1.5,
          }}
        >
          Your AI employees handle customer calls, qualify leads, and book appointments 24/7. Describe their job above or create one from scratch.
        </p>
        <button
          type="button"
          className="btn-build-employee"
          onClick={onNavigateToBuilder}
        >
          + Build My First Employee
        </button>
      </div>
    );
  }

  return (
    <div>
      {errorNotice && (
        <div className="alert-box alert-error" style={{ marginBottom: 16 }}>
          <span>⚠️</span>
          <span>{errorNotice}</span>
        </div>
      )}

      <div className="agents-grid">
        {agents.map((agent) => (
          <div key={agent.id} className="agent-card">
            <div className="agent-card-header">
              <div>
                <h4 className="agent-name">{agent.name}</h4>
                <span className="agent-role-pill">{agent.role}</span>
              </div>
              <span
                className={`agent-status-pill ${
                  agent.status === 'ACTIVE' ? 'active' : 'paused'
                }`}
              >
                ● {agent.status}
              </span>
            </div>

            <div className="agent-prompt-preview" title={agent.systemPrompt}>
              {agent.systemPrompt}
            </div>

            <div className="agent-meta-row">
              <span>🗣️ {agent.primaryLanguage}</span>
              <span>•</span>
              <span>🎙️ {agent.voiceTier}</span>
              {agent.englishEnhance && (
                <>
                  <span>•</span>
                  <span>✨ Enhanced</span>
                </>
              )}
            </div>

            <div className="agent-action-btns">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSelectedAgent(agent)}
              >
                🔍 Details
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={actionInProgress === agent.id}
                onClick={() => handleToggleStatus(agent)}
              >
                {agent.status === 'ACTIVE' ? '⏸️ Pause' : '▶️ Resume'}
              </button>
              <button
                type="button"
                className="btn-danger-outline"
                style={{ marginLeft: 'auto' }}
                disabled={actionInProgress === agent.id}
                onClick={() => handleDelete(agent)}
              >
                🗑️
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Agent Detail Modal Drawer */}
      {selectedAgent && (
        <div className="modal-overlay" onClick={() => setSelectedAgent(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">{selectedAgent.name}</h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  ID: {selectedAgent.id}
                </span>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setSelectedAgent(null)}
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                <div>
                  <div className="form-label">Role</div>
                  <span className="agent-role-pill">{selectedAgent.role}</span>
                </div>
                <div>
                  <div className="form-label">Status</div>
                  <span
                    className={`agent-status-pill ${
                      selectedAgent.status === 'ACTIVE' ? 'active' : 'paused'
                    }`}
                  >
                    ● {selectedAgent.status}
                  </span>
                </div>
                <div>
                  <div className="form-label">Primary Language</div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                    {selectedAgent.primaryLanguage}
                  </div>
                </div>
                <div>
                  <div className="form-label">Voice Tier</div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                    {selectedAgent.voiceTier}
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div className="form-label">System Prompt & Instructions</div>
                <div
                  style={{
                    backgroundColor: '#f8fafc',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 8,
                    padding: 14,
                    fontSize: '0.85rem',
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 240,
                    overflowY: 'auto',
                  }}
                >
                  {selectedAgent.systemPrompt}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 16, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                <span>Interruption Sensitivity: {selectedAgent.interruptionSensitivity}</span>
                <span>•</span>
                <span>LLM Temperature: {selectedAgent.llmTemperature}</span>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSelectedAgent(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
