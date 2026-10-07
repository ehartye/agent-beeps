// Export a patch or a song as delivered WAVs (+ the portable sidecar). The CLI export commands and `beeps build` share this,
// so a build writes exactly the files `beeps export --manifest` and `beeps song export --manifest` write.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { BeepsError } from './errors.ts';
import { readWav } from './audio/wav.ts';
import { compileSong } from '../runtime/engine/sequence.js';
import { renderAndMeasure } from './render/pipeline.ts';
import { renderSong } from './render/song-pipeline.ts';
import { addChannels, layerWavPath, nullResidualDb, readChannels, renderLayers, stateTrim } from './render/layers.ts';
import { resolveInstruments } from './music.ts';
import { writeExportManifest, type ExportRole } from './export-manifest.ts';
import type { OpenProject } from './project.ts';
import type { RenderHost } from './render/host.ts';
import type { Patch } from './schema/patch.ts';
import type { Song } from './schema/song.ts';

/** Every variant 0..n-1 of a patch as `<stem>.<i>.wav`, and (with `manifest`) one sidecar `<dest>.json` listing them. */
export async function exportPatchVariants(host: RenderHost, p: OpenProject, patch: Patch, o: { dest: string; seed: number; n: number; role: ExportRole; manifest: boolean }) {
  const outs = await renderAndMeasure(host, Array.from({ length: o.n }, (_, variant) => ({ patch, seed: o.seed, variant })), { project: p.project, rendersDir: p.paths.renders });
  const ok = outs.map(r => { if (!r.ok) throw new BeepsError('E_RENDER', r.error); return r; });
  const stem = o.dest.replace(/\.wav$/i, '');
  mkdirSync(dirname(o.dest), { recursive: true });
  const wavs = ok.map((r, i) => { const f = `${stem}.${i}.wav`; copyFileSync(r.wavPath, f); return f; });
  const weights = patch.variation?.weights;
  const manifest = o.manifest
    ? writeExportManifest(wavs[0], ok[0], o.role, { variants: wavs.map((f, i) => ({ file: basename(f), weight: weights?.[i] ?? 1 })), noRepeat: patch.variation?.noRepeat ?? true }, `${o.dest}.json`)
    : undefined;
  return { first: ok[0], wavs, manifest };
}

/** One variant of a patch as `dest`. */
export async function exportPatchOne(host: RenderHost, p: OpenProject, patch: Patch, o: { dest: string; seed: number; variant: number; role: ExportRole; manifest: boolean }) {
  const [r] = await renderAndMeasure(host, [{ patch, seed: o.seed, variant: o.variant }], { project: p.project, rendersDir: p.paths.renders });
  if (!r.ok) throw new BeepsError('E_RENDER', r.error);
  mkdirSync(dirname(o.dest), { recursive: true });
  copyFileSync(r.wavPath, o.dest);
  const manifest = o.manifest ? writeExportManifest(o.dest, r, o.role) : undefined;
  return { rendered: r, manifest };
}

/** A song (and, with `layers`, each adaptive layer and per-state trim) as `dest` plus its sidecar. */
export async function exportSongAssets(host: RenderHost, p: OpenProject, s: Song, o: { dest: string; role: ExportRole; manifest: boolean; layers: boolean }) {
  const instruments = resolveInstruments(p, s);
  const r = await renderSong(host, s, instruments, { project: p.project, rendersDir: p.paths.renders });
  const layers = o.layers ? await renderLayers(host, s, instruments, r, { project: p.project, rendersDir: p.paths.renders }) : undefined;
  const dest = o.dest;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(r.wavPath, dest);
  let layerFiles: Record<string, string> | undefined, residual: number | undefined, stateTrimDb: Record<string, number> | undefined, stateLufs: Record<string, number> | undefined;
  const warnings: string[] = [];
  if (layers) {
    layerFiles = Object.fromEntries(Object.entries(layers).map(([name, lr]) => { const f = layerWavPath(dest, name); copyFileSync(lr.wavPath, f); return [name, f]; }));
    // Sum one layer at a time, so only the running sum and one layer are ever in memory.
    let sum: Float32Array[] | undefined;
    for (const lr of Object.values(layers)) sum = addChannels(sum, readChannels(lr.wavPath));
    residual = nullResidualDb(readChannels(r.wavPath), sum ?? []);
    // The layers must sum to the approved mix; far above the 16-bit floor means a layer diverged.
    if (residual > -60) warnings.push(`layers differ from the mix by ${Math.round(residual)} dB: a layer does not sum back to the approved mix`);
    // A state plays only some layers, so it is quieter than the whole mix the trim was set on: measure each state's sum and
    // record the gain that brings it to the music loudness (the player applies it), limited so the sum stays under -1.5 dBFS.
    if (s.adaptive && layerFiles) {
      stateTrimDb = {}; stateLufs = {};
      const sr = readWav(readFileSync(r.wavPath)).sampleRate;
      for (const [state, names] of Object.entries(s.adaptive.states)) {
        let sum: Float32Array[] | undefined;
        for (const n of names) sum = addChannels(sum, readChannels(layerFiles[n]));
        const t = sum ? stateTrim(sum, sr, p.project.musicLoudness) : { lufs: -99, trimDb: 0 };
        stateTrimDb[state] = t.trimDb; stateLufs[state] = t.lufs;
      }
    }
    const sounding = new Set(compileSong(s).events.map(e => e.track));
    for (const [name, tracks] of Object.entries(s.adaptive?.layers ?? {})) {
      if (!tracks.some(t => sounding.has(t))) warnings.push(`layer "${name}" is silent in every section`);
    }
  }
  const extra = layerFiles && s.adaptive
    ? { layers: Object.entries(layerFiles).map(([name, f]) => ({ name, file: basename(f) })), states: s.adaptive.states, initialState: s.adaptive.initial, ...(stateTrimDb ? { stateTrimDb } : {}) }
    : {};
  const manifest = o.manifest ? writeExportManifest(dest, r, o.role, extra) : undefined;
  return { rendered: r, layerFiles, residual, stateTrimDb, stateLufs, manifest, warnings };
}
