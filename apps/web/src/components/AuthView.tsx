'use client';

import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export const AuthView: React.FC = () => {
  const { login, register, error, clearError, isLoading } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');

  // Login form state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Register form state
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regOrgName, setRegOrgName] = useState('');
  const [regPassword, setRegPassword] = useState('');

  const [formValidation, setFormValidation] = useState<string | null>(null);

  const handleTabChange = (newMode: 'login' | 'register') => {
    setMode(newMode);
    clearError();
    setFormValidation(null);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormValidation(null);
    if (!loginEmail.trim() || !loginPassword) {
      setFormValidation('Please provide both email and password.');
      return;
    }
    try {
      await login({ email: loginEmail.trim(), password: loginPassword });
    } catch {
      // Error handled in AuthContext
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormValidation(null);
    if (!regName.trim() || !regEmail.trim() || !regOrgName.trim() || !regPassword) {
      setFormValidation('All fields are required.');
      return;
    }
    if (regPassword.length < 8) {
      setFormValidation('Password must be at least 8 characters.');
      return;
    }
    try {
      await register({
        name: regName.trim(),
        email: regEmail.trim(),
        organizationName: regOrgName.trim(),
        password: regPassword,
      });
    } catch {
      // Error handled in AuthContext
    }
  };

  const handleQuickFillDev = () => {
    setMode('login');
    setLoginEmail('vikasreddyk0@gmail.com');
    setLoginPassword('password123');
    clearError();
    setFormValidation(null);
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo">
            AURIS<span>.</span>
          </div>
          <p className="auth-subtitle">
            Autonomous AI Voice Employee Platform
          </p>
        </div>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab-btn ${mode === 'login' ? 'active' : ''}`}
            onClick={() => handleTabChange('login')}
          >
            Sign In
          </button>
          <button
            type="button"
            className={`auth-tab-btn ${mode === 'register' ? 'active' : ''}`}
            onClick={() => handleTabChange('register')}
          >
            Create Account
          </button>
        </div>

        {(error || formValidation) && (
          <div className="alert-box alert-error">
            <span>⚠️</span>
            <span>{formValidation || error}</span>
          </div>
        )}

        {mode === 'login' ? (
          <form onSubmit={handleLoginSubmit}>
            <div className="form-group">
              <label className="form-label">Email Address</label>
              <input
                type="email"
                className="form-input"
                placeholder="name@company.com"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                autoComplete="email"
                disabled={isLoading}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                type="password"
                className="form-input"
                placeholder="••••••••"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                autoComplete="current-password"
                disabled={isLoading}
                required
              />
            </div>

            <button type="submit" className="btn-primary" disabled={isLoading}>
              {isLoading ? (
                <>
                  <span className="spinner" /> Signing in...
                </>
              ) : (
                'Sign In to Dashboard'
              )}
            </button>

            {process.env.NODE_ENV !== 'production' && (
              <button
                type="button"
                className="demo-fill-btn"
                onClick={handleQuickFillDev}
                disabled={isLoading}
              >
                ⚡ Fill Seed Dev Admin (vikasreddyk0@gmail.com)
              </button>
            )}
          </form>
        ) : (
          <form onSubmit={handleRegisterSubmit}>
            <div className="form-group">
              <label className="form-label">Full Name</label>
              <input
                type="text"
                className="form-input"
                placeholder="Vikas Reddy"
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                disabled={isLoading}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Work Email</label>
              <input
                type="email"
                className="form-input"
                placeholder="vikas@myclinic.com"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
                autoComplete="email"
                disabled={isLoading}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Organization / Business Name</label>
              <input
                type="text"
                className="form-input"
                placeholder="City Health Clinics"
                value={regOrgName}
                onChange={(e) => setRegOrgName(e.target.value)}
                disabled={isLoading}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password (min 8 chars)</label>
              <input
                type="password"
                className="form-input"
                placeholder="••••••••"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                autoComplete="new-password"
                disabled={isLoading}
                required
              />
            </div>

            <button type="submit" className="btn-primary" disabled={isLoading}>
              {isLoading ? (
                <>
                  <span className="spinner" /> Creating account...
                </>
              ) : (
                'Create Organization & Start'
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
