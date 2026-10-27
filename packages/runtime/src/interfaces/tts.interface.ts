export interface TTSSynthesizeParams {
  text: string;
  voiceId: string;
  language: string;
  voiceTier?: 'STANDARD' | 'PREMIUM' | 'ULTRA';
  signal?: AbortSignal;
}

export interface ITTSProvider {
  name: string;

  /**
   * Synthesize text into streaming audio buffers (PCM/WAV) with support for immediate cancellation.
   */
  synthesizeStream(params: TTSSynthesizeParams): AsyncIterable<Buffer>;
}
