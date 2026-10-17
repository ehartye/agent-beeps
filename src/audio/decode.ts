// Any audio file to float PCM: WAV (16-bit PCM or 32-bit float) is read directly; everything else (MP3, Ogg, FLAC, 24-bit WAV...) goes
// through ffmpeg at the file's own sample rate and channel count. `rate` resamples through ffmpeg when the file is at another rate:
// the measurements (loudness, psychoacoustics) are defined at beeps' 48 kHz.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeepsError } from '../errors.ts';
import { findFfmpeg } from '../compress.ts';
import { readWav } from './wav.ts';

export interface Decoded { sampleRate: number; channels: Float32Array[]; /** The file's own rate; differs from `sampleRate` after resampling. */ sourceRate: number }

function viaFfmpeg(path: string, rate?: number): { sampleRate: number; channels: Float32Array[] } {
  const ffmpeg = findFfmpeg();
  const dir = mkdtempSync(join(tmpdir(), 'beeps-decode-'));
  const out = join(dir, 'decoded.wav');
  try {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', ...(rate ? ['-ar', String(rate)] : []), '-c:a', 'pcm_f32le', out], { maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new BeepsError('E_RENDER', `ffmpeg could not decode ${path}: ${r.stderr?.toString().trim() || r.error?.message || r.status}`);
    return readWav(readFileSync(out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function native(path: string): { sampleRate: number; channels: Float32Array[] } {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    try { return readWav(buf); } catch { /* an unsupported WAV flavour (24-bit...): let ffmpeg read it */ }
  }
  return viaFfmpeg(path);
}

export function decodeAudio(path: string, { rate }: { rate?: number } = {}): Decoded {
  if (!existsSync(path)) throw new BeepsError('E_NOT_FOUND', `audio file not found: ${path}`);
  const d = native(path);
  if (rate && d.sampleRate !== rate) return { ...viaFfmpeg(path, rate), sourceRate: d.sampleRate };
  return { ...d, sourceRate: d.sampleRate };
}
