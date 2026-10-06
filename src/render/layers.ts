// src/render/layers.ts
// Adaptive layers: each layer rendered alone the way song stems are (the full song with only its
// tracks' notes playing, at the mix's trim), so a game can fade them independently and their sum
// is still the approved mix.
import { readFileSync } from 'node:fs';
import { BeepsError } from '../errors.ts';
import { readWav } from '../audio/wav.ts';
import { integrated, samplePeakDb } from '../measure/loudness.ts';
import { renderSong, type RenderedSong } from './song-pipeline.ts';
import type { RenderHost } from './host.ts';
import type { Song } from '../schema/song.ts';
import type { Patch } from '../schema/patch.ts';
import type { Project } from '../schema/project.ts';

export async function renderLayers(host: RenderHost, song: Song, instruments: Record<string, Patch>, mix: RenderedSong, opts: { project: Project; rendersDir: string }): Promise<Record<string, RenderedSong>> {
  if (!song.adaptive) throw new BeepsError('E_USAGE', `song "${song.name}" has no adaptive block`);
  const out: Record<string, RenderedSong> = {};
  for (const [name, tracks] of Object.entries(song.adaptive.layers)) {
    // Same as song stems: the full song with only this layer's notes, at the mix's trim.
    out[name] = await renderSong(host, song, instruments, { ...opts, trimDb: mix.trimDb, only: tracks });
  }
  return out;
}

/**
 * Add one layer's channels into a running sum (a new sum when `into` is undefined; the layer is
 * never modified). The sum is Float32 like the signals, so an exact split cancels exactly, and
 * only one layer need be held in memory besides the sum.
 */
export function addChannels(into: Float32Array[] | undefined, layer: Float32Array[]): Float32Array[] {
  if (!into) return layer.map(ch => Float32Array.from(ch));
  for (let c = 0; c < into.length; c++) {
    const acc = into[c], ch = layer[c];
    if (ch) for (let i = 0; i < acc.length; i++) acc[i] += ch[i] ?? 0;
  }
  return into;
}

/** Energy of (mix - summed layers) relative to the mix, in dB; -Infinity when they cancel exactly. */
export function nullResidualDb(mix: Float32Array[], sum: Float32Array[]): number {
  let signal = 0, residual = 0;
  for (let c = 0; c < mix.length; c++) {
    const m = mix[c], l = sum[c];
    for (let i = 0; i < m.length; i++) {
      const d = m[i] - (l?.[i] ?? 0);
      signal += m[i] * m[i];
      residual += d * d;
    }
  }
  return residual === 0 ? -Infinity : 10 * Math.log10(residual / signal);
}

/** The residual as reported in JSON, which has no -Infinity: a perfect null reads as -200 dB. */
export const reportedResidualDb = (db: number): number => (Number.isFinite(db) ? Math.round(db * 10) / 10 : -200);

/** `<stem>.<layer>.wav` next to the mix WAV; only a real .wav extension is replaced. */
export const layerWavPath = (wav: string, layer: string): string => `${wav.replace(/\.wav$/i, '')}.${layer}.wav`;

export const readChannels = (wavPath: string): Float32Array[] => readWav(readFileSync(wavPath)).channels;

/** The gain that brings a state (the sum of its layers) to the music loudness, kept under -1.5 dBFS sample peak and within +-12 dB. */
export function stateTrim(sum: Float32Array[], sampleRate: number, targetLufs: number): { lufs: number; peakDb: number; trimDb: number } {
  const lufs = integrated(sum, sampleRate).lufs, peakDb = samplePeakDb(sum);
  if (!Number.isFinite(lufs)) return { lufs: -99, peakDb: -99, trimDb: 0 };
  const trimDb = Math.round(Math.max(-12, Math.min(12, targetLufs - lufs, -1.5 - peakDb)) * 10) / 10;
  return { lufs: Math.round(lufs * 10) / 10, peakDb: Math.round(peakDb * 10) / 10, trimDb };
}

/** The song with only these tracks: their patterns and sections stay, everything else (and the adaptive block) is dropped, so lint judges the state as its own piece. */
export function stateSong(song: Song, tracks: string[]): Song {
  const out = structuredClone(song);
  delete out.adaptive;
  out.tracks = Object.fromEntries(Object.entries(out.tracks).filter(([t]) => tracks.includes(t)));
  const used = new Set<string>();
  for (const sec of Object.values(out.sections)) {
    sec.play = Object.fromEntries(Object.entries(sec.play).filter(([t]) => tracks.includes(t)));
    if (sec.mix) sec.mix = Object.fromEntries(Object.entries(sec.mix).filter(([t]) => tracks.includes(t)));
    for (const ref of Object.values(sec.play)) for (const p of Array.isArray(ref) ? ref : ref === null ? [] : [ref]) used.add(p);
  }
  out.patterns = Object.fromEntries(Object.entries(out.patterns).filter(([p]) => used.has(p)));
  return out;
}
