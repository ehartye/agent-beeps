// The input hash of one asset, computed from sources alone (no browser, no ffmpeg run).
//
// inputHash = sha256 of { renders, export, toolchain, delivery }, each itself a sha256:
//   renders   the render keys the asset needs. They already cover the patch or the song with its resolved instruments, the render
//             options, the engine version, the sample rate, the pipeline version and the loudness targets, so editing an instrument
//             changes exactly the songs that resolve it. An adaptive song's layers are renders of the same song, so its mix key covers them.
//   export    id, role, kind, seed, variants, layers: what the export step does with the renders
//   toolchain engine, pipeline, song pipeline (songs only: a patch does not depend on it), export pipeline, Chromium and Playwright versions
//   delivery  format, the bitrate of this asset's role, encoder flags, ffmpeg build (WAV: just the format)
import { compileSong } from '../../runtime/engine/sequence.js';
import { canonicalJson, sha256 } from '../hash.ts';
import { loadPatch } from '../project.ts';
import { loadSong } from '../music.ts';
import { resolveInstruments } from '../music.ts';
import { patchRenderKey } from '../render/pipeline.ts';
import { songRenderKey } from '../render/song-pipeline.ts';
import type { OpenProject } from '../project.ts';
import type { Delivery, Recipe } from './config.ts';
import type { Toolchain } from './lock.ts';
import { deliveryOf, runtimePart, wantsBaked, wantsRuntime, type Delivery as AssetDelivery } from '../runtime/cue.ts';

export interface Planned {
  recipe: Recipe;
  inputHash: string;
  parts: { delivery: string; export: string; renders: string; toolchain: string; runtime?: string };
  /** How the asset ships: baked (the encoded file), runtime (the cue a game plays live) or both. */
  ships: AssetDelivery;
  /** What the export step needs: variants for a patch, layers for an adaptive song. */
  variants: number;
  layers: boolean;
  /** An upper bound on the delivered bytes, for a budget check before any render. */
  estimateBytes: number;
}

export interface Encoder { ffmpeg: string; libavcodec: string }

const h12 = (hex: string) => hex.slice(0, 12);

/** What a patch asset depends on: a song-pipeline bump must not make every sound effect stale. */
const withoutSongPipeline = ({ songPipeline: _songs, ...rest }: Toolchain): Omit<Toolchain, 'songPipeline'> => rest;

export function planAsset(p: OpenProject, recipe: Recipe, delivery: Delivery, toolchain: Toolchain, encoder: Encoder | undefined): Planned {
  let renders: string[], variants = 1, layers = false, seconds: number, runtime: string | undefined;
  let ships: AssetDelivery = 'baked';
  if (recipe.kind === 'patch') {
    const patch = loadPatch(p, recipe.source);
    ships = deliveryOf(patch, recipe.delivery);
    // A runtime-only asset needs one render (variant 0 at the input defaults) to measure its trim; the game makes variants itself.
    variants = wantsBaked(ships) ? (recipe.variants ?? patch.variation?.variants ?? 1) : 1;
    if (wantsRuntime(ships)) runtime = runtimePart(patch);
    renders = Array.from({ length: variants }, (_, v) => patchRenderKey(patch, p.project, recipe.seed, v));
    seconds = patch.duration * variants;
  } else {
    const song = loadSong(p, recipe.source);
    layers = !!song.adaptive;
    renders = [songRenderKey(song, resolveInstruments(p, song), { target: p.project.musicLoudness })];
    seconds = compileSong(song).length * (layers ? Object.keys(song.adaptive!.layers).length + 1 : 1);
  }
  const rate = (r: 'music' | 'ambience' | 'sfx' | 'mix') => delivery.kbps?.[r] ?? 0;
  const deliveryPart = !wantsBaked(ships)
    ? { format: 'runtime' } // no encoder, bitrate or container is involved: changing them must not rebuild a cue
    : delivery.format === 'wav'
    ? { format: 'wav' }
    : { format: delivery.format, kbps: rate(recipe.role), ...(layers ? { mixKbps: Math.min(rate(recipe.role), rate('mix')) } : {}), flags: delivery.flags, ...(encoder ?? {}) };
  const parts = {
    delivery: sha256(canonicalJson(deliveryPart)),
    // `delivery` joins the export step only when the asset ships a cue, so every baked asset keeps the hash it always had.
    export: sha256(canonicalJson({ id: recipe.id, role: recipe.role, kind: recipe.kind, seed: recipe.seed, variants, layers, ...(ships !== 'baked' ? { delivery: ships } : {}) })),
    renders: sha256(canonicalJson(renders)),
    toolchain: sha256(canonicalJson(recipe.kind === 'patch' ? withoutSongPipeline(toolchain) : toolchain)),
    ...(runtime ? { runtime } : {}),
  };
  const bytes = !wantsBaked(ships) ? 8192 : delivery.format === 'wav' ? seconds * 48000 * 4 : (seconds * rate(recipe.role) * 1000) / 8;
  return {
    recipe, variants, layers, ships,
    inputHash: `sha256:${sha256(canonicalJson({ schema: 'beeps-input@1', ...parts }))}`,
    parts: { delivery: h12(parts.delivery), export: h12(parts.export), renders: h12(parts.renders), toolchain: h12(parts.toolchain), ...(runtime ? { runtime: h12(runtime) } : {}) },
    estimateBytes: Math.ceil(bytes * 1.1),
  };
}
