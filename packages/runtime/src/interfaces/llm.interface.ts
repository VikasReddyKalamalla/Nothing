export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMGenerateParams {
  systemPrompt: string;
  conversationHistory: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ILLMProvider {
  name: string;

  /**
   * Stream LLM response tokens asynchronously with support for immediate cancellation.
   */
  generateResponseStream(params: LLMGenerateParams): AsyncIterable<string>;
}
