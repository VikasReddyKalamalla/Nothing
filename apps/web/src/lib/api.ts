/**
 * Auris Platform API Client
 * Connects Next.js Frontend to Auris Fastify Control Plane API
 */

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4005';

export interface User {
  id: string;
  email: string;
  name: string;
  role?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  defaultLanguage?: string;
  smartFollowups?: boolean;
  role?: string;
}

export interface Wallet {
  id: string;
  organizationId?: string;
  currency: string;
  balanceCredits: number;
  reservedCredits: number;
  availableCredits: number;
  isLowBalance?: boolean;
  recentTransactions?: CreditTransaction[];
}

export interface CreditTransaction {
  id: string;
  walletId: string;
  amountCredits: number | string;
  balanceAfter: number | string;
  type: string;
  referenceId?: string;
  idempotencyKey?: string;
  description?: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  organizationId: string;
  name: string;
  role: 'TELECALLER' | 'RECEPTIONIST' | 'SURVEYOR' | 'COLLECTOR' | 'CUSTOM';
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  systemPrompt: string;
  primaryLanguage: string;
  secondaryLanguages: string[];
  englishEnhance: boolean;
  voiceTier: 'STANDARD' | 'PREMIUM' | 'ULTRA';
  interruptionSensitivity: number;
  llmTemperature: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  user: User;
  org: Organization;
  wallet: Wallet;
  token: string;
}

export interface MeResponse {
  user: User;
  org: Organization;
  wallet: Wallet;
}

export class ApiError extends Error {
  statusCode: number;
  data: any;

  constructor(message: string, statusCode: number, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('auris_token');
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (options.body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (token && !headers['authorization'] && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `${API_BASE_URL}${endpoint}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (err: any) {
    throw new ApiError(
      `Network error connecting to Auris API at ${url}: ${err.message}`,
      0
    );
  }

  const contentType = response.headers.get('content-type');
  let data: any = null;
  if (contentType && contentType.includes('application/json')) {
    data = await response.json().catch(() => null);
  } else {
    data = await response.text().catch(() => null);
  }

  if (!response.ok) {
    const errorMessage =
      data?.message ||
      data?.error ||
      `Request failed with status ${response.status}`;
    throw new ApiError(errorMessage, response.status, data);
  }

  return data as T;
}

// Auth API
export const authApi = {
  login: (credentials: { email: string; password: string }) =>
    apiRequest<AuthResponse>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    }),

  register: (payload: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
  }) =>
    apiRequest<AuthResponse>('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getMe: () => apiRequest<MeResponse>('/v1/auth/me'),
};

// Agents API
export const agentsApi = {
  list: (orgId: string) => apiRequest<Agent[]>(`/v1/agents/${orgId}`),

  get: (orgId: string, agentId: string) =>
    apiRequest<Agent>(`/v1/agents/${orgId}/${agentId}`),

  create: (
    orgId: string,
    payload: {
      name: string;
      role: 'TELECALLER' | 'RECEPTIONIST' | 'SURVEYOR' | 'COLLECTOR' | 'CUSTOM';
      systemPrompt: string;
      primaryLanguage: string;
      secondaryLanguages?: string[];
      englishEnhance?: boolean;
      voiceTier?: 'STANDARD' | 'PREMIUM' | 'ULTRA';
      interruptionSensitivity?: number;
      llmTemperature?: number;
    }
  ) =>
    apiRequest<Agent>(`/v1/agents/${orgId}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  update: (
    orgId: string,
    agentId: string,
    payload: Partial<{
      name: string;
      role: 'TELECALLER' | 'RECEPTIONIST' | 'SURVEYOR' | 'COLLECTOR' | 'CUSTOM';
      systemPrompt: string;
      primaryLanguage: string;
      secondaryLanguages: string[];
      englishEnhance: boolean;
      voiceTier: 'STANDARD' | 'PREMIUM' | 'ULTRA';
      status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
      interruptionSensitivity: number;
      llmTemperature: number;
    }>
  ) =>
    apiRequest<Agent>(`/v1/agents/${orgId}/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  delete: (orgId: string, agentId: string) =>
    apiRequest<{ success: boolean; deletedAgentId: string }>(
      `/v1/agents/${orgId}/${agentId}`,
      {
        method: 'DELETE',
      }
    ),
};

// Wallets API
export const walletsApi = {
  getBalance: (orgId: string) =>
    apiRequest<Wallet>(`/v1/wallets/${orgId}/balance`),

  topUp: (
    orgId: string,
    payload: {
      amountCredits: number;
      idempotencyKey: string;
      description?: string;
    }
  ) =>
    apiRequest<{ status: string; newBalance: number; transaction: CreditTransaction }>(
      `/v1/wallets/${orgId}/topup`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
};
