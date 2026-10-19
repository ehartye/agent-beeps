// Runtime cues: the file `beeps build` writes for a patch whose delivery is `runtime` or `both`. It is the parsed patch (with its
// xRuntime block) plus what a game cannot compute without the toolchain: the seed the baked asset uses and the loudness trim the
// baked pipeline measured for it, so the live voice plays at the level of the exported file. The game loads it with `parseCue`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUE_SCHEMA, type Cue, type SampleAssetManifest } from '../../runtime/engine/index.js';
import { ENGINE_VERSION } from '../../runtime/engine/version.js';
import { BeepsError } from '../errors.ts';
import { canonicalJson, sha256 } from '../hash.ts';
import { renderAndMeasure } from '../render/pipeline.ts';
import type { RenderHost } from '../render/host.ts';
import type { Patch } from '../schema/patch.ts';
import type { Project } from '../schema/project.ts';

export type { Cue };
export { CUE_SCHEMA };

/** How a patch's delivery was decided: the recipe's, else the patch's own `xRuntime.delivery`, else baked. */
export type Delivery = 'baked' | 'runtime' | 'both';
export const deliveryOf = (patch: Patch, recipe?: Delivery): Delivery => recipe ?? patch.xRuntime?.delivery ?? 'baked';
export const wantsRuntime = (d: Delivery) => d !== 'baked';
export const wantsBaked = (d: Delivery) => d !== 'runtime';

/** `<id>.runtime.json`: next to the baked files, and not matching their sidecar names (`*.wav.json`, `*.ogg.json`). */
export const cueFile = (id: string) => `${id}.runtime.json`;

export function makeCue(patch: Patch, project: Project, seed: number, trimDb: number, assets?: SampleAssetManifest): Cue {
  return { schema: CUE_SCHEMA, id: patch.name, engine: ENGINE_VERSION, seed, trimDb, scale: project.scale, patch, ...(assets && Object.keys(assets).length ? { assets } : {}) };
}

/** The cue as written: canonical JSON (sorted keys), one line, LF, so equal cues are equal bytes. */
export function cueText(cue: Cue): string {
  return canonicalJson(cue) + '\n';
}

/** The part of an asset's input hash the runtime artefact adds: everything in the cue that the baked render key ignores (the xRuntime block). */
export const runtimePart = (patch: Patch): string => sha256(canonicalJson({ schema: CUE_SCHEMA, patch }));

/** Measure the baked pipeline's loudness trim for each patch at its seed (variant 0, input defaults) and make its cue. */
export async function cuesFor(host: RenderHost, patches: Patch[], project: Project, { seeds = {}, rendersDir = join(mkdtempSync(join(tmpdir(), 'beeps-renders-')), 'renders'), sampleObjectsDir }: { seeds?: Record<string, number>; rendersDir?: string; sampleObjectsDir?: string } = {}): Promise<Cue[]> {
  const items = patches.map(patch => ({ patch, seed: seeds[patch.name] ?? 1, variant: 0 }));
  const out = await renderAndMeasure(host, items, { project, rendersDir, sampleObjectsDir });
  return out.map((o, i) => {
    if (!o.ok) throw new BeepsError('E_RENDER', `${o.patchName}: ${o.error}`);
    return makeCue(patches[i], project, items[i].seed, o.trimDb);
  });
}
