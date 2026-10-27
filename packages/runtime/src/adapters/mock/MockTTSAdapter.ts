import { ITTSProvider, TTSSynthesizeParams } from '../../interfaces/tts.interface.js';

export interface MockTTSOptions {
  firstChunkDelayMs?: number;
  chunkIntervalMs?: number;
  failNextSynthesis?: boolean;
}

export class MockTTSAdapter implements ITTSProvider {
  public name = 'mock-tts';
  private options: MockTTSOptions;
  public totalChunksEmitted = 0;
  public totalBytesEmitted = 0;

  constructor(options: MockTTSOptions = {}) {
    this.options = {
      firstChunkDelayMs: 30,
      chunkIntervalMs: 20,
      ...options,
    };
  }

  setOptions(options: Partial<MockTTSOptions>) {
    this.options = { ...this.options, ...options };
  }

  async *synthesizeStream(params: TTSSynthesizeParams): AsyncIterable<Buffer> {
    if (this.options.failNextSynthesis) {
      this.options.failNextSynthesis = false;
      throw new Error('MOCK_TTS_SERVICE_UNAVAILABLE');
    }

    // 1. First chunk latency
    if (this.options.firstChunkDelayMs && this.options.firstChunkDelayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), this.options.firstChunkDelayMs);
        if (params.signal) {
          params.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        }
      });
    }

    if (params.signal?.aborted) {
      return;
    }

    // Generate simulated audio buffers proportional to text length
    // e.g. 1 buffer per 15 characters, minimum 1 chunk
    const chunkCount = Math.max(1, Math.ceil(params.text.length / 20));

    for (let i = 0; i < chunkCount; i++) {
      if (params.signal?.aborted) {
        return;
      }

      // Generate simulated 320-byte PCM frame (20ms of 8kHz 16-bit mono audio)
      const simulatedAudio = Buffer.alloc(320);
      simulatedAudio.fill(0x55 + (i % 10)); // Simulated audio tone data

      this.totalChunksEmitted++;
      this.totalBytesEmitted += simulatedAudio.length;

      yield simulatedAudio;

      if (this.options.chunkIntervalMs && this.options.chunkIntervalMs > 0 && i < chunkCount - 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), this.options.chunkIntervalMs);
          if (params.signal) {
            params.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            });
          }
        });
      }
    }
  }
}
