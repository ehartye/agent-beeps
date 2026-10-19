// Any audio file to float PCM: WAV (16-bit PCM or 32-bit float) is read directly; everything else (MP3, Ogg, FLAC, 24-bit WAV...) goes
// through ffmpeg at the file's own sample rate and channel count. `rate` resamples through ffmpeg when the file is at another rate:
// the measurements (loudness, psychoacoustics) are defined at beeps' 48 kHz.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeepsError } from '../errors.ts';
import { ffmpegFingerprint, findFfmpeg } from '../compress.ts';
import { readWav, UnsupportedWavError, type WavReadLimits } from './wav.ts';

export type DecoderIdentity = { name: 'beeps-wav'; version: 1 } | { name: 'ffmpeg'; ffmpeg: string; libavcodec: string };
export interface Decoded { sampleRate: number; channels: Float32Array[]; /** The file's own rate; differs from `sampleRate` after resampling. */ sourceRate: number; decoder?: DecoderIdentity }
export interface DecodeOptions extends WavReadLimits { rate?: number; maxInputBytes?: number; /** Include the actual decoder build in provenance. */ identity?: boolean }

type DecodeResult = { sampleRate: number; channels: Float32Array[]; sourceRate?: number; decoder?: DecoderIdentity };

function viaFfmpeg(path: string, options: DecodeOptions): DecodeResult {
  const { rate, maxFrames, maxChannels, maxSeconds, identity } = options;
  const ffmpeg = findFfmpeg();
  const dir = mkdtempSync(join(tmpdir(), 'beeps-decode-'));
  const out = join(dir, 'decoded.wav');
  try {
    const run = (args: string[]) => {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', ...args], { maxBuffer: 1 << 20, timeout: maxSeconds !== undefined || maxFrames !== undefined ? 120000 : undefined });
      if (r.status !== 0) throw new BeepsError('E_RENDER', `ffmpeg could not decode ${path}: ${r.stderr?.toString().trim() || r.error?.message || r.status}`);
    };
    let sourceRate: number | undefined, sourceChannels: number | undefined;
    // A zero-duration WAV provides native stream metadata without decoding the whole stream.
    // This also rejects excessive channels before the actual PCM decode or resampling.
    if (rate !== undefined || maxSeconds !== undefined || maxFrames !== undefined || maxChannels !== undefined) {
      const probe = join(dir, 'probe.wav');
      run(['-t', '0', '-c:a', 'pcm_f32le', probe]);
      if (statSync(probe).size > 1 << 20) throw new BeepsError('E_SCHEMA', 'audio metadata exceeds byte bound');
      const metadata = readWav(readFileSync(probe), { maxChannels });
      sourceRate = metadata.sampleRate; sourceChannels = metadata.channels.length;
    }
    const outputRate = rate ?? sourceRate;
    // Decode one sentinel frame beyond the limit, then reject rather than silently truncating.
    // A duration cap stops compressed streams; a byte cap also bounds hostile channel counts.
    const seconds = Math.min(maxSeconds ?? Infinity, maxFrames !== undefined && outputRate ? maxFrames / outputRate : Infinity);
    const bounded = Number.isFinite(seconds);
    const sentinelSeconds = seconds + 1 / (outputRate ?? 8000);
    const outputBytes = Math.ceil((seconds + 1) * (outputRate ?? 384000) * (sourceChannels ?? 64) * 4) + 65536;
    run([...(rate ? ['-ar', String(rate)] : []), ...(bounded ? ['-t', String(sentinelSeconds), '-fs', String(outputBytes)] : []), '-c:a', 'pcm_f32le', out]);
    if (bounded && statSync(out).size > outputBytes + 65536) throw new BeepsError('E_SCHEMA', 'decoded audio exceeds byte bound');
    return { ...readWav(readFileSync(out), { maxFrames, maxChannels, maxSeconds }), sourceRate, ...(identity ? { decoder: { name: 'ffmpeg' as const, ...ffmpegFingerprint(ffmpeg) } } : {}) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function native(path: string, options: DecodeOptions): DecodeResult {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    const seconds = Math.min(options.maxSeconds ?? Infinity, options.rate && options.maxFrames !== undefined ? options.maxFrames / options.rate : Infinity);
    try { return { ...readWav(buf, { maxFrames: options.rate ? undefined : options.maxFrames, maxChannels: options.maxChannels, maxSeconds: Number.isFinite(seconds) ? seconds : undefined }), ...(options.identity ? { decoder: { name: 'beeps-wav' as const, version: 1 as const } } : {}) }; }
    catch (e) { if (!(e instanceof UnsupportedWavError)) throw e; }
  }
  return viaFfmpeg(path, options);
}

export function decodeAudio(path: string, options: DecodeOptions = {}): Decoded {
  const { rate, maxInputBytes } = options;
  for (const key of ['rate', 'maxInputBytes', 'maxFrames', 'maxChannels', 'maxSeconds'] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || (key !== 'maxSeconds' && !Number.isSafeInteger(value)))) throw new BeepsError('E_SCHEMA', `invalid audio ${key} bound`);
  }
  if (!existsSync(path)) throw new BeepsError('E_NOT_FOUND', `audio file not found: ${path}`);
  if (maxInputBytes !== undefined && statSync(path).size > maxInputBytes) throw new BeepsError('E_SCHEMA', `audio original exceeds ${maxInputBytes} byte bound`);
  const d = native(path, options);
  if (rate && d.sampleRate !== rate) return { ...viaFfmpeg(path, options), sourceRate: d.sampleRate };
  if (options.maxFrames !== undefined && d.channels[0].length > options.maxFrames) throw new BeepsError('E_SCHEMA', `audio frames exceed ${options.maxFrames} bound`);
  return { ...d, sourceRate: d.sourceRate ?? d.sampleRate };
}
