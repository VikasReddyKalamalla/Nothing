import { Buffer } from 'node:buffer';
import { AudioEncoding } from './TelephonyTypes.js';
import {
  MalformedMediaFrameError,
  UnsupportedAudioFormatError,
} from './TelephonyErrors.js';

export interface AudioFormat {
  encoding: AudioEncoding;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  frameDurationMs: number;
  frameSizeBytes: number;
}

export const INTERNAL_AUDIO_FORMAT: Readonly<AudioFormat> = {
  encoding: 'pcm_16000',
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  frameDurationMs: 20,
  frameSizeBytes: 640, // 16000 * 0.02 * (16 / 8) * 1 = 640 bytes
};

export const G711_MULAW_FORMAT: Readonly<AudioFormat> = {
  encoding: 'mulaw_8000',
  sampleRate: 8000,
  channels: 1,
  bitDepth: 8,
  frameDurationMs: 20,
  frameSizeBytes: 160, // 8000 * 0.02 * (8 / 8) * 1 = 160 bytes
};

export interface AudioCodec {
  readonly sourceFormat: AudioFormat;
  readonly targetFormat: AudioFormat;

  /**
   * Decode incoming carrier audio frames into internal Auris format (16kHz 16-bit PCM mono).
   */
  decode(input: Buffer): Buffer;

  /**
   * Encode internal Auris audio frames (16kHz 16-bit PCM mono) into carrier format.
   */
  encode(input: Buffer): Buffer;

  /**
   * Validate frame size and structural alignment.
   */
  validateFrame(frame: Buffer, format: AudioFormat): void;
}

const BIAS = 0x84; // 132
const CLIP = 32635;

/**
 * Encode a single 16-bit signed linear PCM sample (-32768 to +32767) to 8-bit G.711 μ-law.
 * Complies with ITU-T Recommendation G.711.
 */
export function linear16ToMulawSample(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulaw;
}

/**
 * Decode a single 8-bit G.711 μ-law byte to 16-bit signed linear PCM sample.
 * Complies with ITU-T Recommendation G.711.
 */
export function mulawSampleToLinear16(ulaw: number): number {
  ulaw = ~ulaw & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

// Precomputed lookup table for O(1) μ-law decoding
const MULAW_TO_LINEAR16_TABLE: Int16Array = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  MULAW_TO_LINEAR16_TABLE[i] = mulawSampleToLinear16(i);
}

/**
 * Standards-compliant ITU-T G.711 μ-law Codec with linear interpolation resampling.
 * Bridges carrier 8kHz G.711 μ-law (160 bytes/20ms) and Auris internal 16kHz linear PCM (640 bytes/20ms).
 */
export class G711MuLawCodec implements AudioCodec {
  public readonly sourceFormat: AudioFormat = G711_MULAW_FORMAT;
  public readonly targetFormat: AudioFormat = INTERNAL_AUDIO_FORMAT;

  /**
   * Validate frame alignment and size constraints.
   */
  public validateFrame(frame: Buffer, format: AudioFormat): void {
    if (!Buffer.isBuffer(frame)) {
      throw new MalformedMediaFrameError('Input audio frame must be a Buffer');
    }

    if (frame.length === 0) {
      return; // Safe empty frame handling
    }

    const bytesPerSample = format.bitDepth / 8;
    if (frame.length % bytesPerSample !== 0) {
      throw new MalformedMediaFrameError(
        `Audio frame byte length (${frame.length}) is not aligned to sample boundary (${bytesPerSample} bytes/sample)`
      );
    }

    if (format.frameSizeBytes > 0 && frame.length > format.frameSizeBytes * 10) {
      throw new MalformedMediaFrameError(
        `Audio frame byte length (${frame.length}) exceeds safe maximum frame limit`
      );
    }
  }

  /**
   * Decode 8kHz G.711 μ-law audio into 16kHz 16-bit Linear PCM (internal format).
   * Upsamples 1:2 using linear interpolation.
   */
  public decode(input: Buffer): Buffer {
    this.validateFrame(input, this.sourceFormat);
    if (input.length === 0) {
      return Buffer.alloc(0);
    }

    const sampleCount8k = input.length;
    const sampleCount16k = sampleCount8k * 2;
    const output = Buffer.alloc(sampleCount16k * 2);

    for (let i = 0; i < sampleCount8k; i++) {
      const muByte = input[i];
      const pcmCurrent = MULAW_TO_LINEAR16_TABLE[muByte];
      const nextMuByte = i + 1 < sampleCount8k ? input[i + 1] : muByte;
      const pcmNext = MULAW_TO_LINEAR16_TABLE[nextMuByte];

      // Linear interpolation for the inter-sample point
      const pcmInterp = Math.round((pcmCurrent + pcmNext) / 2);

      output.writeInt16LE(pcmCurrent, i * 4);
      output.writeInt16LE(pcmInterp, i * 4 + 2);
    }

    return output;
  }

  /**
   * Encode 16kHz 16-bit Linear PCM audio into 8kHz G.711 μ-law (carrier format).
   * Downsamples 2:1 with consecutive sample averaging (anti-aliasing).
   */
  public encode(input: Buffer): Buffer {
    this.validateFrame(input, this.targetFormat);
    if (input.length === 0) {
      return Buffer.alloc(0);
    }

    if (input.length % 2 !== 0) {
      throw new MalformedMediaFrameError('Linear PCM 16-bit input length must be an even number of bytes');
    }

    const sampleCount16k = input.length / 2;
    const sampleCount8k = Math.floor(sampleCount16k / 2);
    const output = Buffer.alloc(sampleCount8k);

    for (let i = 0; i < sampleCount8k; i++) {
      const s0 = input.readInt16LE(i * 4);
      const s1 = input.readInt16LE(i * 4 + 2);
      const avg = Math.round((s0 + s1) / 2);
      output[i] = linear16ToMulawSample(avg);
    }

    return output;
  }
}

/**
 * PassThroughCodec for carriers that already deliver native 16kHz Linear PCM.
 */
export class PassThroughPCM16kCodec implements AudioCodec {
  public readonly sourceFormat: AudioFormat = INTERNAL_AUDIO_FORMAT;
  public readonly targetFormat: AudioFormat = INTERNAL_AUDIO_FORMAT;

  public validateFrame(frame: Buffer, format: AudioFormat): void {
    if (!Buffer.isBuffer(frame)) {
      throw new MalformedMediaFrameError('Audio frame must be a Buffer');
    }
    if (frame.length % 2 !== 0) {
      throw new MalformedMediaFrameError('PCM 16-bit frame must be aligned to 2-byte boundaries');
    }
  }

  public decode(input: Buffer): Buffer {
    this.validateFrame(input, this.sourceFormat);
    return input;
  }

  public encode(input: Buffer): Buffer {
    this.validateFrame(input, this.targetFormat);
    return input;
  }
}
