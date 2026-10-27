'use client';

import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { agentsApi, Agent } from '../lib/api';

interface AgentBuilderProps {
  onAgentCreated: (agent: Agent) => void;
}

export const AgentBuilder: React.FC<AgentBuilderProps> = ({ onAgentCreated }) => {
  const { organization } = useAuth();

  const [selectedChannel, setSelectedChannel] = useState<'instant' | 'bulk' | 'inbound'>('instant');
  const [selectedLang, setSelectedLang] = useState('English');
  const [agentName, setAgentName] = useState('');
  const [promptText, setPromptText] = useState('');
  const [englishEnhance, setEnglishEnhance] = useState(true);
  const [voiceTier, setVoiceTier] = useState<'STANDARD' | 'PREMIUM'>('STANDARD');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const languages = ['తెలుగు', 'हिन्दी', 'தமிழ்', 'ಕನ್ನಡ', 'മലയാളം', 'मराठी', 'English'];

  const templates = [
    {
      name: 'Real estate',
      defaultName: 'Real Estate Site Visit Caller',
      prompt:
        'You are an AI sales assistant for Sai Constructions. Greet the client politely and ask if they are looking for a 2BHK or 3BHK flat in Kondapur. Inquire about their approximate budget and offer to book an on-site visit for Saturday. Confirm their WhatsApp number to send Google Maps coordinates.',
    },
    {
      name: 'Hospital & clinic',
      defaultName: 'Dr. Reddy Clinic Appointment Assistant',
      prompt:
        'You are the receptionist at Dr. Reddy Healthcare Clinic. Greet the caller warmly, confirm whether they need a consultation or follow-up, ask for their primary symptoms, and offer the next available slot at 4:30 PM. Provide directions and clinic hours.',
    },
    {
      name: 'Coaching & tuition',
      defaultName: 'Apex Academy Admission Counselor',
      prompt:
        'You are an educational counselor for Apex Coaching Institute. Inquire about the student’s current grade and target competitive exam (JEE/NEET). Explain our weekend batch with a 15-student limit, and reserve a free trial demo class for Sunday.',
    },
    {
      name: 'Car dealership',
      defaultName: 'City Motors Test Drive Coordinator',
      prompt:
        'You are an automotive concierge for City Motors. Follow up on the customer’s recent inquiry regarding the new SUV model. Ask if they have an existing vehicle for exchange valuation and schedule a home test drive for this Saturday afternoon.',
    },
  ];

  const handleSelectTemplate = (tpl: (typeof templates)[0]) => {
    setPromptText(tpl.prompt);
    if (!agentName) {
      setAgentName(tpl.defaultName);
    }
    setValidationError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setSuccessMessage(null);

    if (!organization?.id) {
      setValidationError('No active organization found. Please sign in again.');
      return;
    }

    const effectiveName = agentName.trim() || `${selectedLang} ${selectedChannel === 'inbound' ? 'Receptionist' : 'Telecaller'}`;
    const effectivePrompt = promptText.trim();

    if (effectivePrompt.length < 10) {
      setValidationError('System prompt must be at least 10 characters long.');
      return;
    }

    setIsSubmitting(true);
    try {
      const role = selectedChannel === 'inbound' ? 'RECEPTIONIST' : 'TELECALLER';
      const created = await agentsApi.create(organization.id, {
        name: effectiveName,
        role,
        systemPrompt: effectivePrompt,
        primaryLanguage: selectedLang,
        secondaryLanguages: selectedLang === 'English' ? ['తెలుగు', 'हिन्दी'] : ['English'],
        englishEnhance,
        voiceTier,
        interruptionSensitivity: 0.7,
        llmTemperature: 0.3,
      });

      setSuccessMessage(`Successfully hired AI Employee "${created.name}"!`);
      setPromptText('');
      setAgentName('');
      onAgentCreated(created);
    } catch (err: any) {
      setValidationError(err.message || 'Failed to create AI employee.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="hero-builder-card">
      <div className="builder-tag">DESCRIBE THE JOB — WE BUILD THE EMPLOYEE</div>
      <div className="builder-title-row">
        <h1 className="builder-title">Build your AI employee</h1>
        <span className="builder-free-tag">LIVE API</span>
      </div>
      <p className="builder-subtitle">
        Configure behavior, role, and language. Changes are deployed instantly to the Auris control plane.
      </p>

      {validationError && (
        <div className="alert-box alert-error" style={{ marginBottom: 16 }}>
          <span>⚠️</span>
          <span>{validationError}</span>
        </div>
      )}

      {successMessage && (
        <div className="alert-box alert-success" style={{ marginBottom: 16 }}>
          <span>✅</span>
          <span>{successMessage}</span>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* Calling Channel Selection */}
        <div className="channel-selector">
          <button
            type="button"
            className={`channel-btn ${selectedChannel === 'instant' ? 'active' : ''}`}
            onClick={() => setSelectedChannel('instant')}
          >
            ⚡ Instant Lead Calling
          </button>
          <button
            type="button"
            className={`channel-btn ${selectedChannel === 'bulk' ? 'active' : ''}`}
            onClick={() => setSelectedChannel('bulk')}
          >
            📢 Bulk Outbound
          </button>
          <button
            type="button"
            className={`channel-btn ${selectedChannel === 'inbound' ? 'active' : ''}`}
            onClick={() => setSelectedChannel('inbound')}
          >
            📞 Inbound Receptionist
          </button>
        </div>

        {/* Employee Name */}
        <div style={{ marginBottom: 16 }}>
          <input
            type="text"
            className="form-input"
            placeholder="Employee Name (e.g. Kondapur Real Estate Follow-up Assistant)"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            disabled={isSubmitting}
          />
        </div>

        {/* Language Selection Row */}
        <div className="language-pills-row">
          <span className="lang-label">PRIMARY LANGUAGE:</span>
          {languages.map((lang) => (
            <button
              type="button"
              key={lang}
              className={`lang-pill ${selectedLang === lang ? 'active' : ''}`}
              onClick={() => setSelectedLang(lang)}
            >
              {lang}
            </button>
          ))}

          <label
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: '0.8rem',
              color: '#cbd5e1',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={englishEnhance}
              onChange={(e) => setEnglishEnhance(e.target.checked)}
            />
            English enhance (natural conversational phrasing)
          </label>
        </div>

        {/* Voice Tier Selection */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, fontSize: '0.8rem' }}>
          <span style={{ color: '#94a3b8', fontWeight: 600 }}>VOICE TIER:</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f8fafc', cursor: 'pointer' }}>
            <input
              type="radio"
              name="voiceTier"
              value="STANDARD"
              checked={voiceTier === 'STANDARD'}
              onChange={() => setVoiceTier('STANDARD')}
            />
            Standard (₹5.00/min)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f8fafc', cursor: 'pointer' }}>
            <input
              type="radio"
              name="voiceTier"
              value="PREMIUM"
              checked={voiceTier === 'PREMIUM'}
              onChange={() => setVoiceTier('PREMIUM')}
            />
            Premium Ultra-Realistic (₹7.50/min)
          </label>
        </div>

        {/* System Prompt Box */}
        <textarea
          className="prompt-textarea-box"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          placeholder={`Describe the employee's instructions step-by-step:
1. Greet the customer and mention why you are calling.
2. Verify their requirements and configuration.
3. Check availability for an appointment or follow-up.
4. Conclude professionally and summarize next steps.`}
          disabled={isSubmitting}
          required
        />

        {/* Bottom Bar: Templates & Submit Button */}
        <div className="builder-bottom-bar">
          <div className="template-chips-row">
            <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>Try template:</span>
            {templates.map((tpl) => (
              <button
                type="button"
                key={tpl.name}
                className="template-chip"
                onClick={() => handleSelectTemplate(tpl)}
              >
                {tpl.name}
              </button>
            ))}
          </div>

          <button
            type="submit"
            className="btn-build-employee"
            disabled={isSubmitting}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            {isSubmitting ? (
              <>
                <span className="spinner" />
                Hiring Employee...
              </>
            ) : (
              '✨ Build & Deploy Employee'
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
