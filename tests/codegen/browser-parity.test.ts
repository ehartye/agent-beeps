// The same sound three ways in one real Chromium: baked (the production render path), the interpreter, the generated module.
// Static bindings must be bit-exact; a live input differs from a bake of its value only by float rounding in how detune is applied.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLive, runParity, type CaseReport } from '../../src/codegen/parity.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { parsePatch, type Patch } from '../../src/schema/patch.ts';
import { parseProject } from '../../src/schema/project.ts';

const SPIKE = join(import.meta.dirname, '..', '..', 'library', 'sounds', 'runtime-spike');
const load = (name: string): Patch => {
  const r = parsePatch(JSON.parse(readFileSync(join(SPIKE, 'patches', `${name}.json`), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.patch;
};
const project = parseProject(JSON.parse(readFileSync(join(SPIKE, 'project.json'), 'utf8')));
const cues = ['comet-blaster', 'asteroid-burst', 'hyperdrive-charge', 'engine-drone'].map(n => ({ patch: load(n), trimDb: -9, seed: 4242 }));

describe.skipIf(!(await chromiumAvailable()))('baked vs interpreter vs generated, in Chromium', () => {
  it('static bindings are bit-exact on every path, deterministic over repeats, and the comparison can fail', async () => {
    const [chromium] = await runParity({ cues, scale: project.scale, engines: ['chromium'], runs: 2 });
    const at = (cue: string, label: string): CaseReport => chromium.cases.find(c => c.cue === cue && c.case === label)!;
    expect(chromium.cases.length).toBeGreaterThanOrEqual(cues.length * 4);
    for (const c of chromium.cases) {
      expect(c.distinct, `${c.cue} / ${c.case}`).toEqual({ baked: 1, interp: 1, gen: 1 });
      expect(c.control.bitExact, `${c.cue} / ${c.case}: a different seed must render differently`).toBe(false);
      expect(c.hostEqualsHarness, `${c.cue} / ${c.case}: the harness bake is the production bake`).toBe(true);
    }
    for (const cue of ['comet-blaster', 'asteroid-burst', 'hyperdrive-charge']) {
      for (const label of ['defaults', 'variant 2, other seed', 'inputs at min', 'inputs at max']) {
        const c = at(cue, label);
        expect(c.gen.delivered.bitExact, `${cue} / ${label} gen`).toBe(true);
        expect(c.gen.authored.bitExact, `${cue} / ${label} gen authored`).toBe(true);
        expect(c.interp.delivered.bitExact, `${cue} / ${label} interp`).toBe(true);
      }
    }
    // The held, live-bound engine bed: at its defaults it is the baked sound to the bit (released at its duration)...
    for (const label of ['defaults', 'variant 2, other seed']) {
      expect(at('engine-drone', label).gen.delivered.bitExact).toBe(true);
      expect(at('engine-drone', label).interp.delivered.bitExact).toBe(true);
    }
    // ...and with live inputs moved from the start it differs from a bake of those values only below 16-bit resolution,
    // once the bake does not quantise the pitch to the scale. With the scale on, the bake snaps and the live voice cannot.
    const live = at('engine-drone', 'inputs at max, no scale snap');
    for (const k of ['gen', 'interp'] as const) {
      expect(live[k].delivered.maxAbsDb).toBeLessThan(-75);
      expect(live[k].delivered.correlation).toBeGreaterThan(0.99999);
      for (const [name, d] of Object.entries(live[k].features)) expect(Math.abs(d), `${k} ${name}`).toBeLessThan(0.05);
    }
    expect(at('engine-drone', 'inputs at max').gen.delivered.maxAbsDb).toBeGreaterThan(-20);
  }, 240_000);

  it('moves a live input mid-note without a click and arrives where a static bake would', async () => {
    const drone = cues[3];
    // One voice: with the unison stack the beat phase differs between a voice that was glided and one that was born there.
    const p = structuredClone(drone.patch) as any;
    p.layers[0].source.unison = { voices: 1, detuneCents: 0 };
    const r = parsePatch(p);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const reports = await runLive({ ...drone, patch: r.patch }, project.scale, { input: 'speed', to: 1, at: 0.5, tau: 0.03 });
    expect(reports.length).toBe(2);
    for (const rep of reports) {
      expect(rep.finite).toBe(true);
      expect(rep.stepRatio).toBeLessThan(1.5);
      expect(rep.before.live.pitchHz).toBeCloseTo(rep.before.staticBake.pitchHz!, 0);
      expect(Math.abs(rep.after.live.pitchHz! - rep.after.staticBake.pitchHz!)).toBeLessThan(0.5);
      expect(rep.after.live.pitchHz!).toBeGreaterThan(90);
      expect(Math.abs(rep.after.live.momentaryMaxLufs! - rep.after.staticBake.momentaryMaxLufs!)).toBeLessThan(0.1);
      expect(Math.abs(rep.after.live.centroidHz! - rep.after.staticBake.centroidHz!)).toBeLessThan(3);
    }
  }, 120_000);
});
