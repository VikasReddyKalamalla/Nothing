import { ILLMProvider, LLMGenerateParams } from '../../interfaces/llm.interface.js';

export interface MockLLMOptions {
  timeToFirstTokenMs?: number;
  tokenIntervalMs?: number;
  failNextGeneration?: boolean;
}

export class MockLLMAdapter implements ILLMProvider {
  public name = 'mock-llm';
  private options: MockLLMOptions;
  public customResponses: Map<string, string> = new Map();
  public defaultResponse = 'Hello! I am your AI assistant. How can I help you today?';
  public lastPrompt: string | null = null;
  public lastHistoryLength = 0;

  constructor(options: MockLLMOptions = {}) {
    this.options = {
      timeToFirstTokenMs: 40,
      tokenIntervalMs: 15,
      ...options,
    };
  }

  setOptions(options: Partial<MockLLMOptions>) {
    this.options = { ...this.options, ...options };
  }

  setResponseForPattern(pattern: string, response: string) {
    this.customResponses.set(pattern.toLowerCase(), response);
  }

  async *generateResponseStream(params: LLMGenerateParams): AsyncIterable<string> {
    if (this.options.failNextGeneration) {
      this.options.failNextGeneration = false;
      throw new Error('MOCK_LLM_TIMEOUT');
    }

    this.lastPrompt = params.systemPrompt;
    this.lastHistoryLength = params.conversationHistory.length;

    // Pick response based on last user message
    const lastUserMsg = [...params.conversationHistory].reverse().find((m) => m.role === 'user')?.content.toLowerCase() || '';
    let responseText = this.defaultResponse;

    for (const [pattern, resp] of this.customResponses.entries()) {
      if (lastUserMsg.includes(pattern)) {
        responseText = resp;
        break;
      }
    }

    // 1. Simulate Time To First Token (TTFT)
    if (this.options.timeToFirstTokenMs && this.options.timeToFirstTokenMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), this.options.timeToFirstTokenMs);
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

    // 2. Stream tokens (words or chunks)
    const tokens = responseText.split(' ');
    for (let i = 0; i < tokens.length; i++) {
      if (params.signal?.aborted) {
        return;
      }

      const chunk = (i === 0 ? '' : ' ') + tokens[i];
      yield chunk;

      if (this.options.tokenIntervalMs && this.options.tokenIntervalMs > 0 && i < tokens.length - 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), this.options.tokenIntervalMs);
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
