import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  G711MuLawCodec,
  PassThroughPCM16kCodec,
  linear16ToMulawSample,
  mulawSampleToLinear16,
  INTERNAL_AUDIO_FORMAT,
  G711_MULAW_FORMAT,
} from '../src/telephony/AudioCodec.js';
import { MalformedMediaFrameError } from '../src/telephony/TelephonyErrors.js';

describe('Workstream E: AudioCodec and G.711 μ-Law Boundaries', () => {
  describe('ITU-T G.711 μ-Law Reference Vectors & Companding Invariants', () => {
    it('encodes silence (0) to 0xFF (255) and decodes back to 0', () => {
      const mulaw = linear16ToMulawSample(0);
      expect(mulaw).toBe(0xff);
      const decoded = mulawSampleToLinear16(mulaw);
      expect(decoded).toBe(0);
    });

    it('handles maximum positive saturation (+32767) cleanly', () => {
      const mulaw = linear16ToMulawSample(32767);
      expect(mulaw).toBe(0x80); // 128
      const decoded = mulawSampleToLinear16(mulaw);
      // G.711 quantizes to +32124
      expect(decoded).toBe(32124);
    });

    it('handles maximum negative saturation (-32768) cleanly', () => {
      const mulaw = linear16ToMulawSample(-32768);
      expect(mulaw).toBe(0x00); // 0
      const decoded = mulawSampleToLinear16(mulaw);
      // G.711 quantizes to -32124
      expect(decoded).toBe(-32124);
    });

    it('encodes intermediate reference vectors with expected bounded quantization loss', () => {
      const testCases = [
        { pcm: 1000, expectedUlaw: 0xce, expectedPcm: 988 },
        { pcm: -1000, expectedUlaw: 0x4e, expectedPcm: -988 },
        { pcm: 5000, expectedUlaw: 0xab, expectedPcm: 5116 },
        { pcm: -5000, expectedUlaw: 0x2b, expectedPcm: -5116 },
        { pcm: 16000, expectedUlaw: 0x90, expectedPcm: 15996 },
        { pcm: -16000, expectedUlaw: 0x10, expectedPcm: -15996 },
      ];

      for (const tc of testCases) {
        const encoded = linear16ToMulawSample(tc.pcm);
        expect(encoded).toBe(tc.expectedUlaw);
        const decoded = mulawSampleToLinear16(encoded);
        expect(decoded).toBe(tc.expectedPcm);
      }
    });

    it('maintains sign symmetry across positive and negative inputs', () => {
      const pcmValues = [100, 500, 1200, 4000, 15000, 25000, 32000];
      for (const val of pcmValues) {
        const posDecoded = mulawSampleToLinear16(linear16ToMulawSample(val));
        const negDecoded = mulawSampleToLinear16(linear16ToMulawSample(-val));
        expect(posDecoded).toBe(-negDecoded);
      }
    });
  });

  describe('G711MuLawCodec Frame Processing & Resampling', () => {
    const codec = new G711MuLawCodec();

    it('validates audio format descriptors', () => {
      expect(codec.sourceFormat).toEqual(G711_MULAW_FORMAT);
      expect(codec.targetFormat).toEqual(INTERNAL_AUDIO_FORMAT);
      expect(codec.sourceFormat.sampleRate).toBe(8000);
      expect(codec.sourceFormat.frameSizeBytes).toBe(160);
      expect(codec.targetFormat.sampleRate).toBe(16000);
      expect(codec.targetFormat.frameSizeBytes).toBe(640);
    });

    it('encodes a 20ms 16kHz PCM frame (640 bytes) to 20ms 8kHz μ-law frame (160 bytes)', () => {
      const inputPcm16k = Buffer.alloc(640);
      // Fill with 440 Hz tone
      for (let i = 0; i < 320; i++) {
        const val = Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
        inputPcm16k.writeInt16LE(val, i * 2);
      }

      const encoded = codec.encode(inputPcm16k);
      expect(encoded.length).toBe(160);
      expect(Buffer.isBuffer(encoded)).toBe(true);
    });

    it('decodes a 20ms 8kHz μ-law frame (160 bytes) to 20ms 16kHz PCM frame (640 bytes)', () => {
      const inputUlaw8k = Buffer.alloc(160, 0xff); // 160 bytes of silence
      const decoded = codec.decode(inputUlaw8k);

      expect(decoded.length).toBe(640);
      // All 320 16-bit samples must be 0 (silence)
      for (let i = 0; i < 320; i++) {
        expect(decoded.readInt16LE(i * 2)).toBe(0);
      }
    });

    it('handles empty input buffers safely without throwing', () => {
      const emptyEncoded = codec.encode(Buffer.alloc(0));
      expect(emptyEncoded.length).toBe(0);

      const emptyDecoded = codec.decode(Buffer.alloc(0));
      expect(emptyDecoded.length).toBe(0);
    });

    it('rejects malformed PCM input with unaligned odd byte lengths', () => {
      const malformed = Buffer.alloc(641); // Odd length
      expect(() => codec.encode(malformed)).toThrow(MalformedMediaFrameError);
    });

    it('produces completely deterministic output across repeated runs', () => {
      const input = Buffer.alloc(640);
      for (let i = 0; i < 320; i++) {
        input.writeInt16LE((i * 100) % 32000, i * 2);
      }

      const run1 = codec.encode(input);
      const run2 = codec.encode(input);
      expect(run1.equals(run2)).toBe(true);

      const dec1 = codec.decode(run1);
      const dec2 = codec.decode(run2);
      expect(dec1.equals(dec2)).toBe(true);
    });
  });

  describe('PassThroughPCM16kCodec', () => {
    const passThrough = new PassThroughPCM16kCodec();

    it('passes through 16kHz PCM audio without modification', () => {
      const input = Buffer.alloc(640, 0x42);
      expect(passThrough.encode(input)).toBe(input);
      expect(passThrough.decode(input)).toBe(input);
    });

    it('rejects odd byte lengths', () => {
      const odd = Buffer.alloc(7);
      expect(() => passThrough.encode(odd)).toThrow(MalformedMediaFrameError);
      expect(() => passThrough.decode(odd)).toThrow(MalformedMediaFrameError);
    });
  });
});
