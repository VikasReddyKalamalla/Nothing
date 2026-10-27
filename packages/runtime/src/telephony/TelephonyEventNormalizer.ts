import {
  NormalizedTelephonyEvent,
  TelephonyEventType,
} from './TelephonyTypes.js';
import { TelephonyError } from './TelephonyErrors.js';

export interface RawWebhookPayload {
  event?: string;
  eventType?: string;
  callReference?: string;
  carrierCallId?: string;
  callId?: string;
  timestamp?: number | string;
  reason?: string;
  details?: Record<string, any>;
  [key: string]: any;
}

export class TelephonyEventNormalizer {
  public static normalizeMockEvent(
    raw: RawWebhookPayload,
    providerId = 'mock-telephony'
  ): NormalizedTelephonyEvent {
    if (!raw || typeof raw !== 'object') {
      throw new TelephonyError('Webhook payload must be a non-null object', 'INVALID_PAYLOAD');
    }

    const rawType = (raw.event || raw.eventType || '').toLowerCase();
    const providerCallReference = raw.callReference || raw.carrierCallId;

    if (!providerCallReference) {
      throw new TelephonyError('Payload missing providerCallReference', 'MISSING_CALL_REFERENCE');
    }

    let eventType: TelephonyEventType;
    switch (rawType) {
      case 'initiated':
      case 'call.initiated':
        eventType = 'call.initiated';
        break;
      case 'ringing':
      case 'call.ringing':
        eventType = 'call.ringing';
        break;
      case 'answered':
      case 'connected':
      case 'call.answered':
        eventType = 'call.answered';
        break;
      case 'disconnected':
      case 'ended':
      case 'completed':
      case 'call.disconnected':
        eventType = 'call.disconnected';
        break;
      case 'failed':
      case 'call.failed':
        eventType = 'call.failed';
        break;
      case 'media.started':
        eventType = 'media.started';
        break;
      case 'media.stopped':
        eventType = 'media.stopped';
        break;
      case 'media.error':
        eventType = 'media.error';
        break;
      default:
        throw new TelephonyError(`Unrecognized telephony event type: ${rawType}`, 'UNSUPPORTED_EVENT_TYPE');
    }

    let timestamp: number;
    if (typeof raw.timestamp === 'number' && !isNaN(raw.timestamp)) {
      timestamp = raw.timestamp;
    } else if (typeof raw.timestamp === 'string') {
      const parsed = Date.parse(raw.timestamp);
      timestamp = isNaN(parsed) ? Date.now() : parsed;
    } else {
      timestamp = Date.now();
    }

    const providerEventId = raw.eventId || raw.id || undefined;
    const eventId = providerEventId || `norm-evt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // Build sanitized payload without secrets, tokens, or credentials
    const sanitizedPayload: Record<string, any> = {
      reason: raw.reason || undefined,
      durationSeconds: typeof raw.durationSeconds === 'number' ? raw.durationSeconds : undefined,
    };

    if (raw.details && typeof raw.details === 'object') {
      for (const [k, v] of Object.entries(raw.details)) {
        if (!k.toLowerCase().includes('secret') && !k.toLowerCase().includes('token') && !k.toLowerCase().includes('key')) {
          sanitizedPayload[k] = v;
        }
      }
    }

    return {
      eventId,
      providerEventId,
      providerId,
      eventType,
      providerCallReference,
      callId: raw.callId || undefined,
      timestamp,
      payload: sanitizedPayload,
    };
  }
}
