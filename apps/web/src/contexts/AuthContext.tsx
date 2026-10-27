'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  User,
  Organization,
  Wallet,
  authApi,
  walletsApi,
  ApiError,
} from '../lib/api';

interface AuthContextType {
  user: User | null;
  organization: Organization | null;
  wallet: Wallet | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (credentials: { email: string; password: string }) => Promise<void>;
  register: (payload: {
    name: string;
    email: string;
    password: string;
    organizationName: string;
  }) => Promise<void>;
  logout: () => void;
  refreshWallet: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auris_token');
      localStorage.removeItem('auris_user');
      localStorage.removeItem('auris_org');
    }
    setUser(null);
    setOrganization(null);
    setWallet(null);
    setToken(null);
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const data = await authApi.getMe();
      setUser(data.user);
      setOrganization(data.org);
      setWallet(data.wallet);
    } catch (err: any) {
      if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 403)) {
        clearSession();
      }
      throw err;
    }
  }, [clearSession]);

  const refreshWallet = useCallback(async () => {
    if (!organization?.id) return;
    try {
      const updatedWallet = await walletsApi.getBalance(organization.id);
      setWallet(updatedWallet);
    } catch (err: any) {
      console.error('Failed to refresh wallet:', err);
    }
  }, [organization?.id]);

  // Initial session hydration
  useEffect(() => {
    const initializeSession = async () => {
      setIsLoading(true);
      const savedToken = typeof window !== 'undefined' ? localStorage.getItem('auris_token') : null;

      if (!savedToken) {
        setIsLoading(false);
        return;
      }

      setToken(savedToken);

      try {
        const data = await authApi.getMe();
        setUser(data.user);
        setOrganization(data.org);
        setWallet(data.wallet);
      } catch (err: any) {
        console.warn('Stored token was invalid or expired. Resetting session.');
        clearSession();
      } finally {
        setIsLoading(false);
      }
    };

    initializeSession();
  }, [clearSession]);

  const login = async (credentials: { email: string; password: string }) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await authApi.login(credentials);
      if (typeof window !== 'undefined') {
        localStorage.setItem('auris_token', res.token);
        localStorage.setItem('auris_user', JSON.stringify(res.user));
        localStorage.setItem('auris_org', JSON.stringify(res.org));
      }
      setToken(res.token);
      setUser(res.user);
      setOrganization(res.org);
      setWallet(res.wallet);
    } catch (err: any) {
      const msg = err.message || 'Login failed. Please check your credentials.';
      setError(msg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (payload: {
    name: string;
    email: string;
    password: string;
    organizationName: string;
  }) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await authApi.register(payload);
      if (typeof window !== 'undefined') {
        localStorage.setItem('auris_token', res.token);
        localStorage.setItem('auris_user', JSON.stringify(res.user));
        localStorage.setItem('auris_org', JSON.stringify(res.org));
      }
      setToken(res.token);
      setUser(res.user);
      setOrganization(res.org);
      setWallet(res.wallet);
    } catch (err: any) {
      const msg = err.message || 'Registration failed. Please check your details.';
      setError(msg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    clearSession();
  };

  const clearError = () => setError(null);

  return (
    <AuthContext.Provider
      value={{
        user,
        organization,
        wallet,
        token,
        isAuthenticated: !!token && !!user,
        isLoading,
        error,
        login,
        register,
        logout,
        refreshWallet,
        refreshProfile,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
