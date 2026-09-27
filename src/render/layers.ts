// src/render/layers.ts
// Adaptive layers: each layer rendered alone the way song stems are (loop-folded, at the mix's
// trim), so a game can fade them independently and their sum is still the approved mix.
import { readFileSync } from 'node:fs';
import { BeepsError } from '../errors.ts';
import { readWav } from '../audio/wav.ts';
import { soloSong } from '../music.ts';
import { renderSong, type RenderedSong } from './song-pipeline.ts';
import type { RenderHost } from './host.ts';
import type { Song } from '../schema/song.ts';
import type { Patch } from '../schema/patch.ts';
import type { Project } from '../schema/project.ts';

export async function renderLayers(host: RenderHost, song: Song, instruments: Record<string, Patch>, mix: RenderedSong, opts: { project: Project; rendersDir: string }): Promise<Record<string, RenderedSong>> {
  if (!song.adaptive) throw new BeepsError('E_USAGE', `song "${song.name}" has no adaptive block`);
  const out: Record<string, RenderedSong> = {};
  for (const [name, tracks] of Object.entries(song.adaptive.layers)) {
    // Same as song stems: solo keeps the full form; restore loop folding; reuse the mix's trim.
    const solo = { ...soloSong(song, { only: tracks }), loop: song.loop };
    out[name] = await renderSong(host, solo, instruments, { ...opts, trimDb: mix.trimDb });
  }
  return out;
}

/** Energy of (mix - sum of layers) relative to the mix, in dB; -Infinity when they cancel exactly. */
export function nullResidualDb(mix: Float32Array[], layers: Float32Array[][]): number {
  let signal = 0, residual = 0;
  for (let c = 0; c < mix.length; c++) {
    const m = mix[c];
    for (let i = 0; i < m.length; i++) {
      let sum = 0;
      // Sum at the Float32 precision the signals are stored in, so an exact split cancels exactly.
      for (const layer of layers) sum = Math.fround(sum + (layer[c]?.[i] ?? 0));
      const d = m[i] - sum;
      signal += m[i] * m[i];
      residual += d * d;
    }
  }
  return residual === 0 ? -Infinity : 10 * Math.log10(residual / signal);
}

export const readChannels = (wavPath: string): Float32Array[] => readWav(readFileSync(wavPath)).channels;
