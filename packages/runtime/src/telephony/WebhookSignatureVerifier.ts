import { WebhookVerificationResult } from './TelephonyTypes.js';

export interface WebhookVerificationContext {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
}

export interface IWebhookSignatureVerifier {
  verify(context: WebhookVerificationContext): WebhookVerificationResult;
}
