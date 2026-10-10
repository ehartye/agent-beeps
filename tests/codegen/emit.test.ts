import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEGEN_SOURCES, emitModule } from '../../src/codegen/emit.ts';
import { exportRuntime, patchHash } from '../../src/codegen/export.ts';
import { parsePatch, type Patch } from '../../src/schema/patch.ts';
import { patch } from '../helpers/patches.ts';

const SPIKE = join(import.meta.dirname, '..', '..', 'library', 'sounds', 'runtime-spike', 'patches');
const spike: Patch[] = readdirSync(SPIKE).map(f => {
  const r = parsePatch(JSON.parse(readFileSync(join(SPIKE, f), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.patch;
});

describe('emitModule', () => {
  it('is deterministic', () => {
    for (const p of spike) expect(emitModule(p, { trimDb: -5 }).js).toBe(emitModule(p, { trimDb: -5 }).js);
  });

  it('ships no interpreter and no patch data: it imports the shared helpers only, and contains no source-type literal', () => {
    for (const p of spike) {
      const { js } = emitModule(p, { trimDb: -5 });
      const specs = [...js.matchAll(/from '([^']+)'/g)].map(m => m[1]);
      expect(specs).toEqual(['../engine/gen.js']);
      expect(js).not.toMatch(/buildPatch|buildLayer|buildSource|createVoice|variantPatch|applyParams|"type":"(osc|noise|fm|additive|modal|grains|metal)"/);
    }
  });

  it('bakes the measured trim and the input declarations into meta, and types the input names', () => {
    const drone = spike.find(p => p.name === 'engine-drone')!;
    const e = emitModule(drone, { trimDb: -9.4, seed: 1 });
    expect(e.js).toContain('"trimDb":-9.4');
    expect(e.js).toContain('"hold":true');
    expect(e.dts).toContain('export interface Params { speed?: number; load?: number }');
    expect(e.liveInputs).toEqual(['speed', 'load']);
    const comet = spike.find(p => p.name === 'comet-blaster')!;
    expect(emitModule(comet, { trimDb: -5 }).liveInputs).toEqual([]);
    expect(emitModule(comet, { trimDb: -5 }).staticInputs).toEqual(['size', 'distance']);
  });

  it('states what it does not support instead of emitting something wrong', () => {
    const voice = patch({ schema: 'beeps/patch@1', name: 'v', family: 'test', duration: 0.3, layers: [{ source: { type: 'voice', pitch: 200, formants: [[700, 8, 0], [1200, 8, -3]] }, amp: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.05 } }] });
    expect(() => emitModule(voice, { trimDb: 0 })).toThrow(/"voice" source is not supported/);
    expect(CODEGEN_SOURCES).not.toContain('voice');
  });
});

describe('exportRuntime', () => {
  it('writes the engine subset, one module and declaration per cue, and a manifest keyed by patch hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-export-'));
    const { root, manifest } = exportRuntime(dir, spike.map(patch => ({ patch, trimDb: -6, seed: 9 })));
    expect(readdirSync(join(root, 'cues')).sort()).toEqual(spike.flatMap(p => [`${p.name}.d.ts`, `${p.name}.js`]).sort());
    expect(readdirSync(join(root, 'engine')).sort()).toEqual(['fx.js', 'gen.js', 'layer.js', 'notes.js', 'params.js', 'rng.js', 'sources.js', 'sum.js', 'version.js', 'voice.d.ts']);
    expect(manifest.cues['comet-blaster'].patchHash).toBe(patchHash(spike.find(p => p.name === 'comet-blaster')!));
    const withInterp = exportRuntime(mkdtempSync(join(tmpdir(), 'beeps-export-')), spike.map(patch => ({ patch, trimDb: -6, seed: 9 })), { interpreter: true });
    expect(readdirSync(join(withInterp.root, 'engine'))).toEqual(expect.arrayContaining(['live.js', 'patch.js', 'variation.js']));
  });
});
