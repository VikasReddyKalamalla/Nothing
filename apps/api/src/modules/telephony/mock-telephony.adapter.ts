export interface OutboundCallRequest {
  fromNumber: string;
  toNumber: string;
  agentId: string;
  extraHeaders?: Record<string, string>;
}

export interface CallStatusUpdate {
  carrierCallId: string;
  status: 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'busy' | 'no_answer' | 'failed';
  durationSeconds?: number;
  hangupCause?: string;
}

export interface ITelephonyAdapter {
  initiateOutboundCall(req: OutboundCallRequest): Promise<{ carrierCallId: string; status: string }>;
  terminateCall(carrierCallId: string): Promise<boolean>;
  verifyWebhookSignature(signature: string, payload: string): boolean;
}

/**
 * Mock Telephony Adapter
 * Simulates carrier operations for local testing and deterministic integration testing.
 */
export class MockTelephonyAdapter implements ITelephonyAdapter {
  private activeSimulatedCalls = new Map<string, { status: string; startedAt: number }>();

  async initiateOutboundCall(req: OutboundCallRequest): Promise<{ carrierCallId: string; status: string }> {
    const carrierCallId = `mock-call-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    this.activeSimulatedCalls.set(carrierCallId, {
      status: 'initiated',
      startedAt: Date.now(),
    });

    return {
      carrierCallId,
      status: 'initiated',
    };
  }

  async terminateCall(carrierCallId: string): Promise<boolean> {
    if (this.activeSimulatedCalls.has(carrierCallId)) {
      this.activeSimulatedCalls.delete(carrierCallId);
      return true;
    }
    return false;
  }

  verifyWebhookSignature(signature: string, payload: string): boolean {
    // In mock mode, any signature matching 'mock-valid-sig' or present in test passes
    return signature === 'mock-valid-signature' || process.env.NODE_ENV === 'test';
  }
}
