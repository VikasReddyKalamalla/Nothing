export interface TranscriptEvent {
  speaker: 'agent' | 'caller';
  text: string;
  isFinal: boolean;
  timestampMs: number;
}

export interface ISpeechToTextAdapter {
  transcribeStream(audioChunk: Buffer): Promise<TranscriptEvent | null>;
}

export interface ITextToSpeechAdapter {
  synthesizeSpeech(text: string, voiceId: string): Promise<Buffer>;
}

export interface IConversationEngine {
  generateTurnResponse(params: {
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    systemPrompt: string;
    language: string;
  }): Promise<{ responseText: string; toolCall?: { name: string; args: Record<string, unknown> } }>;
}

export class MockSpeechToTextAdapter implements ISpeechToTextAdapter {
  async transcribeStream(audioChunk: Buffer): Promise<TranscriptEvent | null> {
    if (audioChunk.length === 0) return null;
    return {
      speaker: 'caller',
      text: 'Simulated customer speech: Looking for a 2BHK flat in Hyderabad.',
      isFinal: true,
      timestampMs: Date.now(),
    };
  }
}

export class MockTextToSpeechAdapter implements ITextToSpeechAdapter {
  async synthesizeSpeech(text: string, voiceId: string): Promise<Buffer> {
    // Returns 20ms of silence / dummy PCMU audio (160 bytes)
    return Buffer.alloc(160, 0xff);
  }
}

export class MockConversationEngine implements IConversationEngine {
  async generateTurnResponse(params: {
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    systemPrompt: string;
    language: string;
  }): Promise<{ responseText: string; toolCall?: { name: string; args: Record<string, unknown> } }> {
    return {
      responseText: 'Namaskaram! Yes, we have premium 2BHK flats available in Kondapur.',
      toolCall: {
        name: 'extract_lead_variables',
        args: { configuration: '2BHK', location: 'Kondapur' },
      },
    };
  }
}
