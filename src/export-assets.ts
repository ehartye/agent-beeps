// Export a patch or a song as delivered WAVs (+ the portable sidecar). The CLI export commands and `beeps build` share this,
// so a build writes exactly the files `beeps export --manifest` and `beeps song export --manifest` write.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { toMono, trimTail } from './audio/post.ts';
import { basename, dirname, join } from 'node:path';
import { BeepsError } from './errors.ts';
import { readWav } from './audio/wav.ts';
import { compileSong } from '../runtime/engine/sequence.js';
import { customLoudnessOffset, renderAndMeasure } from './render/pipeline.ts';
import { renderSong } from './render/song-pipeline.ts';
import { addChannels, layerWavPath, nullResidualDb, readChannels, renderLayers, stateTrim } from './render/layers.ts';
import { resolveInstruments } from './music.ts';
import { admitAssetId, writeExportManifest, type ExportRole } from './export-manifest.ts';
import type { OpenProject } from './project.ts';
import type { RenderHost } from './render/host.ts';
import type { Patch } from './schema/patch.ts';
import type { Song } from './schema/song.ts';
import { songRenderOptions, renderOptions } from './render/options.ts';

/** Opt-in export post-processing (beeps export --channels 1, --trim-tail <dBFS>); absent, the WAV is the render's own file. */
export interface ExportPost { channels?: 1 | 2; trimTailDb?: number }
/** Said whenever --channels 1 had to average channels that differ: the sound is not what the stereo measurement describes. */
export const CHANNELS_DIFFER = 'the rendered channels differ (the stereo reverb, or a panned layer): --channels 1 averaged them, so the reverb sits about 3 dB lower and the sidecar loudness is the stereo measurement';

export interface PostResult { channels: number; identicalChannels?: boolean; trimmedTailSec?: number }

/** Copy a rendered WAV to `dest`, applying the opt-in post-processing. */
function deliver(src: string, dest: string, post: ExportPost = {}): PostResult | undefined {
  if (post.channels !== 1 && post.trimTailDb === undefined) { copyFileSync(src, dest); return undefined; }
  let wav: Buffer = readFileSync(src);
  const out: PostResult = { channels: wav.readUInt16LE(22) };
  if (post.trimTailDb !== undefined) { const t = trimTail(wav, post.trimTailDb); wav = t.wav; out.trimmedTailSec = Math.round(t.removedSec * 1e4) / 1e4; }
  if (post.channels === 1) { const m = toMono(wav); wav = m.wav; out.channels = 1; out.identicalChannels = m.identical; }
  writeFileSync(dest, wav);
  return out;
}

const offsetExtra = (patch: Patch, p: OpenProject) => {
  const loudnessOffsetDb = customLoudnessOffset(patch, p.project);
  return loudnessOffsetDb === undefined ? {} : { loudnessOffsetDb };
};

/** Admission precedes cache lookup, DSP and delivery writes; authored render inputs are never renamed. */
function manifestIdentity(o: { manifest: boolean; manifestId?: string }, sourceId: string): { id?: string } {
  if (o.manifestId === undefined) return {};
  if (!o.manifest) throw new BeepsError('E_USAGE', 'manifestId requires a manifest export');
  admitAssetId(o.manifestId, sourceId);
  return { id: o.manifestId };
}

/** Every variant 0..n-1 of a patch as `<stem>.<i>.wav`, and (with `manifest`) one sidecar `<dest>.json` listing them. */
export async function exportPatchVariants(host: RenderHost, p: OpenProject, patch: Patch, o: { dest: string; seed: number; n: number; role: ExportRole; manifest: boolean; manifestId?: string; post?: ExportPost }) {
  const identity = manifestIdentity(o, patch.name);
  const outs = await renderAndMeasure(host, Array.from({ length: o.n }, (_, variant) => ({ patch, seed: o.seed, variant })), renderOptions(p));
  const ok = outs.map(r => { if (!r.ok) throw new BeepsError('E_RENDER', r.error); return r; });
  const stem = o.dest.replace(/\.wav$/i, '');
  mkdirSync(dirname(o.dest), { recursive: true });
  const posts: (PostResult | undefined)[] = [];
  const wavs = ok.map((r, i) => { const f = `${stem}.${i}.wav`; posts.push(deliver(r.wavPath, f, o.post)); return f; });
  const weights = patch.variation?.weights;
  const manifest = o.manifest
    ? writeExportManifest(wavs[0], ok[0], o.role, { variants: wavs.map((f, i) => ({ file: basename(f), weight: weights?.[i] ?? 1 })), noRepeat: patch.variation?.noRepeat ?? true, ...offsetExtra(patch, p), ...identity }, `${o.dest}.json`)
    : undefined;
  return { first: ok[0], rendered: ok, wavs, manifest, posts };
}

/** Variant files `<stem>.<n>.wav` beside `dest` that an export did not write: left by an earlier export with more variants, and picked up by `beeps bundle` as if current. */
export function staleVariantFiles(dest: string, written: string[]): string[] {
  const stem = basename(dest).replace(/\.wav$/i, ''), dir = dirname(dest);
  if (!existsSync(dir)) return [];
  const keep = new Set(written.map(f => basename(f)));
  return readdirSync(dir).filter(f => f.startsWith(stem + '.') && /^\.\d+\.wav$/i.test(f.slice(stem.length)) && !keep.has(f)).sort().map(f => join(dir, f));
}

/** One variant of a patch as `dest`. */
export async function exportPatchOne(host: RenderHost, p: OpenProject, patch: Patch, o: { dest: string; seed: number; variant: number; role: ExportRole; manifest: boolean; post?: ExportPost }) {
  const [r] = await renderAndMeasure(host, [{ patch, seed: o.seed, variant: o.variant }], renderOptions(p));
  if (!r.ok) throw new BeepsError('E_RENDER', r.error);
  mkdirSync(dirname(o.dest), { recursive: true });
  const post = deliver(r.wavPath, o.dest, o.post);
  const manifest = o.manifest ? writeExportManifest(o.dest, r, o.role, offsetExtra(patch, p)) : undefined;
  return { rendered: r, manifest, post };
}

/** A song (and, with `layers`, each adaptive layer and per-state trim) as `dest` plus its sidecar. */
export async function exportSongAssets(host: RenderHost, p: OpenProject, s: Song, o: { dest: string; role: ExportRole; manifest: boolean; manifestId?: string; layers: boolean; sections?: boolean; trimTailDb?: number }) {
  const identity = manifestIdentity(o, s.name);
  // A loop's tail is folded onto its start and layers must stay sample-aligned with the mix: trimming either would break the wrap or the sum.
  if (o.trimTailDb !== undefined && (s.loop || o.layers)) throw new BeepsError('E_USAGE', `--trim-tail is for a non-loop song exported without --layers (${s.loop ? `"${s.name}" loops: its tail wraps onto the start` : 'layers must line up with the mix'})`);
  const instruments = resolveInstruments(p, s);
  const r = await renderSong(host, s, instruments, songRenderOptions(p));
  const layers = o.layers ? await renderLayers(host, s, instruments, r, songRenderOptions(p)) : undefined;
  const dest = o.dest;
  mkdirSync(dirname(dest), { recursive: true });
  const post = deliver(r.wavPath, dest, o.trimTailDb !== undefined ? { trimTailDb: o.trimTailDb } : undefined);
  let layerFiles: Record<string, string> | undefined, residual: number | undefined, stateTrimDb: Record<string, number> | undefined, stateLufs: Record<string, number | null> | undefined;
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
        const t = stateTrim(sum ?? [], sr, p.project.musicLoudness);
        stateTrimDb[state] = t.trimDb; stateLufs[state] = t.lufs;
        if (t.silent) warnings.push(`state "${state}" is silent: none of its layers makes a sound, so it has no level (stateLufs is null) and no trim`);
        if (t.clamped) warnings.push(`state "${state}" needs ${t.clamped.requestedDb} dB to reach the music loudness; the limit is +-12 dB, so it plays at ${t.clamped.appliedDb} dB and sits ${Math.abs(Math.round((t.clamped.requestedDb - t.clamped.appliedDb) * 10) / 10)} dB ${t.clamped.requestedDb < t.clamped.appliedDb ? 'louder' : 'quieter'} than its target`);
      }
    }
    const sounding = new Set(compileSong(s).events.map(e => e.track));
    for (const [name, tracks] of Object.entries(s.adaptive?.layers ?? {})) {
      if (!tracks.some(t => sounding.has(t))) warnings.push(`layer "${name}" is silent in every section`);
    }
  }
  const extra = {
    ...(layerFiles && s.adaptive
      ? { layers: Object.entries(layerFiles).map(([name, f]) => ({ name, file: basename(f) })), states: s.adaptive.states, initialState: s.adaptive.initial, ...(stateTrimDb ? { stateTrimDb } : {}) }
      : {}),
    // The sections are already measured with the render; the sidecar gets them only when asked, so no existing sidecar changes.
    ...(o.sections ? { sectionTimes: r.features.sections.map(({ name, start, end }) => ({ name, start, end })) } : {}),
  };
  const manifest = o.manifest ? writeExportManifest(dest, r, o.role, { ...extra, ...identity }) : undefined;
  return { rendered: r, layerFiles, residual, stateTrimDb, stateLufs, manifest, warnings, post };
}
