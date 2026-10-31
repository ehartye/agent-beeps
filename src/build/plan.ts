// The input hash of one asset, computed from sources alone (no browser, no ffmpeg run).
//
// inputHash = sha256 of { renders, export, toolchain, delivery }, each itself a sha256:
//   renders   the render keys the asset needs. They already cover the patch or the song with its resolved instruments, the render
//             options, the engine version, the sample rate, the pipeline version and the loudness targets, so editing an instrument
//             changes exactly the songs that resolve it. An adaptive song's layers are renders of the same song, so its mix key covers them.
//   export    id, role, kind, seed, variants, layers: what the export step does with the renders
//   toolchain engine, pipeline, song pipeline (songs only: a patch does not depend on it), export pipeline, Chromium and Playwright versions
//   delivery  format, the bitrate of this asset's role, encoder flags, ffmpeg build (WAV: just the format)
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inspectPcm16 } from '../audio/post.ts';
import { AUDIO_SPRITE_MAX_INPUT_BYTES, AUDIO_SPRITE_MAX_WAV_BYTES, AUDIO_SPRITE_MAX_SAMPLE_RATE, AUDIO_SPRITE_PACKING_VERSION } from '../audio-sprite-map.ts';
import type { AudioSpriteInput } from '../audio/sprite.ts';
import { compileSong } from '../../runtime/engine/sequence.js';
import { canonicalJson, sha256 } from '../hash.ts';
import { loadPatch } from '../project.ts';
import { loadSong } from '../music.ts';
import { resolveInstruments } from '../music.ts';
import { patchRenderKey } from '../render/pipeline.ts';
import { songRenderKey } from '../render/song-pipeline.ts';
import type { OpenProject } from '../project.ts';
import type { Delivery, Recipe, SpriteRecipe } from './config.ts';
import type { Toolchain } from './lock.ts';
import { BeepsError } from '../errors.ts';
import { admitAssetId } from '../export-manifest.ts';
import { cueText, makeCue, deliveryOf, runtimePart, wantsBaked, wantsRuntime, type Delivery as AssetDelivery } from '../runtime/cue.ts';
import { cueSources } from '../runtime/delivery.ts';
import { samplePaths } from '../samples/store.ts';

export interface Planned {
  recipe: Recipe;
  /** Exact planned source hashes: refuse a source changed between planning and packing. */
  spriteSources?: string[];
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
  if (recipe.kind === 'sprite') {
    if (delivery.preset !== 'wav-master' || delivery.format !== 'wav') throw new BeepsError('E_SCHEMA', 'PCM sprites support only the wav-master target');
    const inputs = readSpriteInputs(recipe);
    const spriteSources = inputs.map(input => createHash('sha256').update(input.wav).digest('hex'));
    const sampleRate = inspectPcm16(inputs[0].wav).sampleRate, channels = inspectPcm16(inputs[0].wav).channels;
    const wavBytes = 44 + inputs.reduce((n, input) => n + input.wav.length - 44, 0) + (inputs.length - 1) * Math.ceil(sampleRate / 10) * channels * 2;
    const parts = {
      delivery: sha256(canonicalJson({ format: 'wav' })),
      export: sha256(canonicalJson({ id: recipe.id, role: recipe.role, kind: recipe.kind, packing: AUDIO_SPRITE_PACKING_VERSION, entries: recipe.entries.map(({ id, loop }) => ({ id, loop })) })),
      renders: sha256(canonicalJson(spriteSources)),
      toolchain: sha256(canonicalJson({ pcmSpritePacking: AUDIO_SPRITE_PACKING_VERSION })),
    };
    return { recipe, spriteSources, ships: 'baked', variants: 1, layers: false,
      inputHash: `sha256:${sha256(canonicalJson({ schema: 'beeps-input@1', ...parts }))}`,
      parts: { delivery: h12(parts.delivery), export: h12(parts.export), renders: h12(parts.renders), toolchain: h12(parts.toolchain) },
      // Each bounded map entry is under 1 KiB, including hashes, IDs and integer frame fields.
      estimateBytes: wavBytes + 512 + inputs.length * 1024,
    };
  }
  let renders: string[], variants = 1, layers = false, seconds: number, runtime: string | undefined;
  let ships: AssetDelivery = 'baked';
  let runtimeBytes = 0;
  if (recipe.kind === 'patch') {
    const patch = loadPatch(p, recipe.source);
    // Verify actual source bytes even for baked-only, before any warm/check/adopt reuse.
    const sources = cueSources(patch, recipe.id, samplePaths(p).objects);
    admitAssetId(recipe.id, patch.name);
    ships = deliveryOf(patch, recipe.delivery);
    if (wantsRuntime(ships) && patch.name !== recipe.id) {
      throw new BeepsError('E_SCHEMA', `recipe "${recipe.id}" is the patch "${patch.name}": runtime and both delivery require the authored patch name`, { hint: 'use the patch name as the recipe id, or select delivery "baked" for a delivery alias' });
    }
    // A runtime-only asset needs one render (variant 0 at the input defaults) to measure its trim; the game makes variants itself.
    variants = wantsBaked(ships) ? (recipe.variants ?? patch.variation?.variants ?? 1) : 1;
    if (wantsRuntime(ships)) {
      runtime = runtimePart(patch);
      // Reserve 32 bytes for the unknown measured trim's numeric representation.
      runtimeBytes = [...sources.files.values()].reduce((n, b) => n + b.length, 0) + Buffer.byteLength(cueText(makeCue(patch, p.project, recipe.seed, 0, sources.assets))) + 32;
    }
    renders = Array.from({ length: variants }, (_, v) => patchRenderKey(patch, p.project, recipe.seed, v));
    seconds = patch.duration * variants;
  } else {
    const song = loadSong(p, recipe.source);
    admitAssetId(recipe.id, song.name);
    layers = !!song.adaptive;
    renders = [songRenderKey(song, resolveInstruments(p, song), { target: p.project.musicLoudness })];
    seconds = compileSong(song).length * (layers ? Object.keys(song.adaptive!.layers).length + 1 : 1);
  }
  if ((recipe.channels !== undefined || recipe.trimTailDb !== undefined) && (recipe.kind !== 'patch' || !wantsBaked(ships))) {
    throw new BeepsError('E_SCHEMA', `recipe "${recipe.id}": channels and tail trimming are for baked patch files, not ${recipe.kind !== 'patch' ? 'songs or layers' : 'runtime-only delivery'}`, { pointer: `/${recipe.id}/${recipe.channels !== undefined ? 'channels' : 'trimTailDb'}` });
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
    export: sha256(canonicalJson({ id: recipe.id, role: recipe.role, kind: recipe.kind, seed: recipe.seed, variants, layers, ...(recipe.sections ? { sections: true } : {}), ...(ships !== 'baked' ? { delivery: ships } : {}), ...(recipe.channels !== undefined ? { channels: recipe.channels } : {}), ...(recipe.trimTailDb !== undefined ? { trimTailDb: recipe.trimTailDb } : {}) })),
    renders: sha256(canonicalJson(renders)),
    toolchain: sha256(canonicalJson(recipe.kind === 'patch' ? withoutSongPipeline(toolchain) : toolchain)),
    ...(runtime ? { runtime } : {}),
  };
  const bytes = !wantsBaked(ships) ? 0 : delivery.format === 'wav' ? seconds * 48000 * 4 : (seconds * rate(recipe.role) * 1000) / 8;
  return {
    recipe, variants, layers, ships,
    inputHash: `sha256:${sha256(canonicalJson({ schema: 'beeps-input@1', ...parts }))}`,
    parts: { delivery: h12(parts.delivery), export: h12(parts.export), renders: h12(parts.renders), toolchain: h12(parts.toolchain), ...(runtime ? { runtime: h12(runtime) } : {}) },
    estimateBytes: Math.ceil(bytes * 1.1) + runtimeBytes,
  };
}

/** Preflight every header and the total packed size before allocating any source audio buffer. */
export function readSpriteInputs(recipe: SpriteRecipe): AudioSpriteInput[] {
  const opened: { fd: number; size: number; header: Buffer }[] = [];
  try {
    let sampleRate = 0, channels = 0, frames = 0;
    for (const [index, entry] of recipe.entries.entries()) {
      const fd = openSync(entry.source, 'r');
      const record = { fd, size: 0, header: Buffer.alloc(44) }; opened.push(record);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > AUDIO_SPRITE_MAX_INPUT_BYTES || stat.size < 44) throw new BeepsError('E_SCHEMA', `sprite entry "${entry.id}" must be a regular PCM WAV of at most 16 MiB`);
      record.size = stat.size;
      if (readSync(fd, record.header, 0, 44, 0) !== 44) throw new BeepsError('E_SCHEMA', `sprite entry "${entry.id}" has a truncated header`);
      const pcm = inspectPcm16(record.header, stat.size);
      if (pcm.channels > 2 || pcm.sampleRate > AUDIO_SPRITE_MAX_SAMPLE_RATE || pcm.frames < 1) throw new BeepsError('E_SCHEMA', `sprite entry "${entry.id}" requires nonempty mono/stereo PCM16 at 1–192000 Hz`);
      if (!index) { sampleRate = pcm.sampleRate; channels = pcm.channels; }
      else if (sampleRate !== pcm.sampleRate || channels !== pcm.channels) throw new BeepsError('E_SCHEMA', 'all sprite entries must have the same sample rate and channel count');
      frames += pcm.frames + (index ? Math.ceil(sampleRate / 10) : 0);
      const packedBytes = 44 + frames * channels * 2;
      if (!Number.isSafeInteger(packedBytes) || packedBytes > AUDIO_SPRITE_MAX_WAV_BYTES) throw new BeepsError('E_SCHEMA', 'packed sprite WAV exceeds the 64 MiB size limit');
    }
    return opened.map(({ fd, size, header }, index) => {
      const wav = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const n = readSync(fd, wav, read, size - read, read);
        if (!n) throw new BeepsError('E_SCHEMA', 'sprite source changed or truncated during read');
        read += n;
      }
      if (fstatSync(fd).size !== size || !wav.subarray(0, 44).equals(header)) throw new BeepsError('E_SCHEMA', 'sprite source changed during read');
      return { id: recipe.entries[index].id, loop: recipe.entries[index].loop, wav };
    });
  } finally {
    for (const { fd } of opened) closeSync(fd);
  }
}
