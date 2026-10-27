import { PrismaClient, SpeakerType } from '@auris/database';
import { CallState, CallEventRecord } from '../types/session.types.js';

export interface EventLoggerOptions {
  prisma?: PrismaClient;
  redactKeys?: string[];
}

export class CallEventLogger {
  private readonly events: CallEventRecord[] = [];
  private readonly redactKeys: Set<string>;

  constructor(
    private readonly callId: string,
    private readonly options: EventLoggerOptions = {}
  ) {
    this.redactKeys = new Set([
      'authorization',
      'password',
      'secret',
      'token',
      'audio',
      'buffer',
      ...(options.redactKeys || []),
    ]);
  }

  getEvents(): ReadonlyArray<CallEventRecord> {
    return this.events;
  }

  /**
   * Sanitize an object to ensure no credentials, tokens, or raw binary audio are logged.
   */
  public sanitize(data?: Record<string, any>): Record<string, any> | undefined {
    if (!data) return undefined;
    const sanitized: Record<string, any> = {};

    for (const [key, val] of Object.entries(data)) {
      if (this.redactKeys.has(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else if (Buffer.isBuffer(val)) {
        sanitized[key] = `[BUFFER:${val.length}B]`;
      } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        sanitized[key] = this.sanitize(val);
      } else {
        sanitized[key] = val;
      }
    }
    return sanitized;
  }

  /**
   * Record a call event with automatic sanitization and optional Prisma persistence.
   */
  async logEvent(
    eventType: string,
    fromState?: CallState,
    toState?: CallState,
    payload?: Record<string, any>,
    latencyMs?: number
  ): Promise<CallEventRecord> {
    const sanitizedPayload = this.sanitize(payload);
    const eventRecord: CallEventRecord = {
      eventType,
      fromState,
      toState,
      payload: sanitizedPayload,
      latencyMs,
      timestamp: new Date(),
    };

    this.events.push(eventRecord);

    // Optional DB persistence
    if (this.options.prisma) {
      try {
        await this.options.prisma.callEvent.create({
          data: {
            callId: this.callId,
            eventType,
            fromState: fromState?.toString(),
            toState: toState?.toString(),
            payloadJson: sanitizedPayload ? JSON.parse(JSON.stringify(sanitizedPayload)) : undefined,
            latencyMs,
          },
        });
      } catch (err: any) {
        // Non-fatal logging error
        console.warn(`[CallEventLogger] Failed to persist call event to DB: ${err.message}`);
      }
    }

    return eventRecord;
  }

  private readonly sessionStartTime: number = Date.now();

  /**
   * Persist a completed conversation turn to the database Transcripts table.
   */
  async logTranscript(speaker: 'CALLER' | 'AGENT', text: string, timestampMs: number, languageCode?: string) {
    const offsetMs = timestampMs > 2_000_000_000
      ? Math.max(0, Math.min(2_000_000_000, timestampMs - this.sessionStartTime))
      : Math.max(0, Math.min(2_000_000_000, timestampMs));

    if (this.options.prisma) {
      try {
        await this.options.prisma.transcript.create({
          data: {
            callId: this.callId,
            speaker: speaker === 'AGENT' ? SpeakerType.AGENT : SpeakerType.CALLER,
            text,
            timestampMs: offsetMs,
            languageCode,
          },
        });
      } catch (err: any) {
        console.warn(`[CallEventLogger] Failed to persist transcript: ${err.message}`);
      }
    }
  }

  /**
   * Finalize the call record in the database upon session termination.
   */
  async finalizeCallRecord(data: {
    status: any;
    durationSeconds: number;
    billableSeconds: number;
    creditsDeducted: number;
    startedAt?: Date;
    endedAt: Date;
    terminationReason: string;
    outcome?: any;
  }) {
    if (this.options.prisma) {
      try {
        await this.options.prisma.call.update({
          where: { id: this.callId },
          data: {
            status: data.status,
            durationSeconds: data.durationSeconds,
            billableSeconds: data.billableSeconds,
            creditsDeducted: data.creditsDeducted,
            startedAt: data.startedAt,
            endedAt: data.endedAt,
            terminationReason: data.terminationReason,
            outcome: data.outcome,
          },
        });
      } catch (err: any) {
        console.warn(`[CallEventLogger] Failed to finalize call record: ${err.message}`);
      }
    }
  }
}
