// EXPERIMENTAL (runtime-codegen spike). Turn patches into emit-ready cues: the seed the project's kit recorded (else 1) and the loudness
// trim the baked pipeline measures for it, so a generated module plays at exactly the level the exported WAV has.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeepsError } from '../errors.ts';
import { renderAndMeasure } from '../render/pipeline.ts';
import type { RenderHost } from '../render/host.ts';
import type { Patch } from '../schema/patch.ts';
import type { Project } from '../schema/project.ts';
import type { CueInput } from './export.ts';

export async function cuesFor(host: RenderHost, patches: Patch[], project: Project, { seeds = {}, rendersDir = join(mkdtempSync(join(tmpdir(), 'beeps-renders-')), 'renders') }: { seeds?: Record<string, number>; rendersDir?: string } = {}): Promise<CueInput[]> {
  const items = patches.map(patch => ({ patch, seed: seeds[patch.name] ?? 1, variant: 0 }));
  const out = await renderAndMeasure(host, items, { project, rendersDir });
  return out.map((o, i) => {
    if (!o.ok) throw new BeepsError('E_RENDER', `${o.patchName}: ${o.error}`);
    return { patch: patches[i], trimDb: o.trimDb, seed: items[i].seed };
  });
}
