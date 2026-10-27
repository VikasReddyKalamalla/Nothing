import { EventEmitter } from 'events';
import { ISTTProvider, ISTTStream, STTConfig } from '../../interfaces/stt.interface.js';

export class MockSTTStream extends EventEmitter implements ISTTStream {
  private activeTimers: NodeJS.Timeout[] = [];
  private aborted = false;

  constructor(public readonly callId: string, public readonly config: STTConfig) {
    super();
  }

  pushAudio(chunk: Buffer): void {
    if (this.aborted || chunk.length === 0) return;
    // Audio chunks pushed from telephony can trigger voice activity detection
    this.emit('speechStart');
  }

  async finish(): Promise<void> {
    this.clearTimers();
  }

  abort(): void {
    this.aborted = true;
    this.clearTimers();
    this.emit('aborted');
  }

  private clearTimers() {
    for (const t of this.activeTimers) {
      clearTimeout(t);
    }
    this.activeTimers = [];
  }

  /**
   * Deterministic simulator helper: Emits speechStart, partial transcripts, then final transcript.
   */
  simulateSpeech(
    text: string,
    options: {
      speechStartDelayMs?: number;
      partialIntervalMs?: number;
      finalLatencyMs?: number;
    } = {}
  ): Promise<void> {
    if (this.aborted) return Promise.resolve();

    const startDelay = options.speechStartDelayMs ?? 10;
    const partialInterval = options.partialIntervalMs ?? 30;
    const finalLatency = options.finalLatencyMs ?? 40;

    return new Promise((resolve) => {
      // 1. Voice activity detected -> speechStart
      const t1 = setTimeout(() => {
        if (this.aborted) return resolve();
        this.emit('speechStart');

        // 2. Stream partial transcripts (word by word)
        const words = text.split(' ');
        let currentPart = '';
        words.forEach((word, idx) => {
          const tPart = setTimeout(() => {
            if (this.aborted) return;
            currentPart += (idx > 0 ? ' ' : '') + word;
            this.emit('partialTranscript', currentPart);
          }, (idx + 1) * partialInterval);
          this.activeTimers.push(tPart);
        });

        // 3. Final transcript
        const totalPartialTime = words.length * partialInterval;
        const tFinal = setTimeout(() => {
          if (this.aborted) return resolve();
          this.emit('finalTranscript', text, finalLatency);
          resolve();
        }, totalPartialTime + finalLatency);
        this.activeTimers.push(tFinal);
      }, startDelay);

      this.activeTimers.push(t1);
    });
  }
}

export class MockSTTAdapter implements ISTTProvider {
  public name = 'mock-stt';
  public lastStream: MockSTTStream | null = null;
  public failNextStream = false;

  async createStream(callId: string, config: STTConfig): Promise<ISTTStream> {
    if (this.failNextStream) {
      this.failNextStream = false;
      throw new Error('MOCK_STT_CONNECTION_FAILED');
    }
    const stream = new MockSTTStream(callId, config);
    this.lastStream = stream;
    return stream;
  }
}
