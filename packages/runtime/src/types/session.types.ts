/**
 * Auris Voice Runtime - Session Types & State Definitions
 */

export type CallDirection = 'INBOUND' | 'OUTBOUND_INSTANT' | 'OUTBOUND_BULK' | 'BROWSER_TEST';

export enum CallState {
  INITIALIZING = 'INITIALIZING',
  RESERVING = 'RESERVING',
  RINGING = 'RINGING',
  ACTIVE = 'ACTIVE',
  SPEAKING = 'SPEAKING',
  LISTENING = 'LISTENING',
  PROCESSING = 'PROCESSING',
  TERMINATING = 'TERMINATING',
  SETTLING = 'SETTLING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export interface StateTransition {
  from: CallState;
  to: CallState;
  trigger: string;
  timestamp: number;
  reason?: string;
  metadata?: Record<string, any>;
}

export interface CallSessionConfig {
  callId: string;
  organizationId: string;
  agentId: string;
  agentVersionId?: string;
  direction: CallDirection;
  callerNumber: string;
  destinationNumber: string;
  systemPrompt: string;
  language: string;
  voiceTier: 'STANDARD' | 'PREMIUM' | 'ULTRA';
  voiceId?: string;
  interruptionSensitivity?: number; // 0.0 to 1.0 (default: 0.7)
  llmTemperature?: number;          // 0.0 to 1.0 (default: 0.3)
  initialReservationCredits?: number;
  ratePerMinute?: number;
}

export interface StageLatencies {
  sttLatencyMs?: number;
  llmFirstTokenMs?: number;
  ttsFirstChunkMs?: number;
  totalTurnaroundMs?: number;
  bargeInLatencyMs?: number;
}

export interface ConversationTurn {
  turnId: string;
  speaker: 'CALLER' | 'AGENT' | 'SYSTEM';
  text: string;
  timestampMs: number;
  interrupted?: boolean;
  latencies?: StageLatencies;
}

export interface CallEventRecord {
  eventType: string;
  fromState?: CallState;
  toState?: CallState;
  payload?: Record<string, any>;
  latencyMs?: number;
  timestamp: Date;
}
