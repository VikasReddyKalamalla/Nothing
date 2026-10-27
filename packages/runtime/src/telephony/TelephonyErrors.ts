export class TelephonyError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'TELEPHONY_ERROR') {
    super(message);
    this.name = 'TelephonyError';
    this.code = code;
  }
}

export class InvalidWebhookSignatureError extends TelephonyError {
  constructor(message = 'Invalid webhook signature or verification failed') {
    super(message, 'INVALID_WEBHOOK_SIGNATURE');
    this.name = 'InvalidWebhookSignatureError';
  }
}

export class WebhookReplayError extends TelephonyError {
  constructor(message = 'Webhook request replayed or timestamp out of tolerance') {
    super(message, 'WEBHOOK_REPLAY_DETECTED');
    this.name = 'WebhookReplayError';
  }
}

export class ExpiredStreamTokenError extends TelephonyError {
  constructor(message = 'Media stream token has expired') {
    super(message, 'EXPIRED_STREAM_TOKEN');
    this.name = 'ExpiredStreamTokenError';
  }
}

export class InvalidStreamTokenError extends TelephonyError {
  constructor(message = 'Invalid, malformed, or untrusted media stream token') {
    super(message, 'INVALID_STREAM_TOKEN');
    this.name = 'InvalidStreamTokenError';
  }
}

export class StreamTokenReusedError extends TelephonyError {
  constructor(message = 'Media stream token has already been claimed') {
    super(message, 'STREAM_TOKEN_REUSED');
    this.name = 'StreamTokenReusedError';
  }
}

export class QueueOverflowError extends TelephonyError {
  constructor(message = 'Audio queue capacity exceeded') {
    super(message, 'QUEUE_OVERFLOW');
    this.name = 'QueueOverflowError';
  }
}

export class UnsupportedAudioFormatError extends TelephonyError {
  constructor(message = 'Unsupported audio format or codec parameters') {
    super(message, 'UNSUPPORTED_AUDIO_FORMAT');
    this.name = 'UnsupportedAudioFormatError';
  }
}

export class MalformedMediaFrameError extends TelephonyError {
  constructor(message = 'Malformed media frame, invalid JSON, or invalid base64') {
    super(message, 'MALFORMED_MEDIA_FRAME');
    this.name = 'MalformedMediaFrameError';
  }
}

export class UnauthenticatedStreamError extends TelephonyError {
  constructor(message = 'WebSocket connection is not authenticated for this call session') {
    super(message, 'UNAUTHENTICATED_STREAM');
    this.name = 'UnauthenticatedStreamError';
  }
}

export class CallNotReadyForMediaError extends TelephonyError {
  constructor(message = 'Call session is not ready to receive audio frames') {
    super(message, 'CALL_NOT_READY_FOR_MEDIA');
    this.name = 'CallNotReadyForMediaError';
  }
}

export class CarrierAdapterError extends TelephonyError {
  constructor(message: string, code = 'CARRIER_ADAPTER_ERROR') {
    super(message, code);
    this.name = 'CarrierAdapterError';
  }
}

export class CarrierInitiationFailedError extends CarrierAdapterError {
  constructor(message = 'Carrier outbound call initiation failed') {
    super(message, 'CARRIER_INITIATE_FAILED');
    this.name = 'CarrierInitiationFailedError';
  }
}

export class CarrierCallNotFoundError extends CarrierAdapterError {
  constructor(message = 'Carrier call reference not found') {
    super(message, 'CARRIER_CALL_NOT_FOUND');
    this.name = 'CarrierCallNotFoundError';
  }
}

export class InvalidCarrierEventError extends CarrierAdapterError {
  constructor(message = 'Malformed or unsupported carrier event payload') {
    super(message, 'INVALID_CARRIER_EVENT');
    this.name = 'InvalidCarrierEventError';
  }
}
