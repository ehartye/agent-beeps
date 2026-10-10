// The same sound two ways in one real Chromium: baked (the production render path) and played by the runtime voice. Static
// bindings must be bit-exact; a live input differs from a bake of its value only by float rounding in how detune is applied; a
// shared reverb bus is the same sound summed elsewhere.
import { describe, expect, it } from 'vitest';
import { runLive, runParity, type CaseReport } from '../../src/runtime/harness.ts';
import { makeCue } from '../../src/runtime/cue.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { parsePatch } from '../../src/schema/patch.ts';
import { example, exampleProject } from '../helpers/runtime-examples.ts';

const project = exampleProject();
const cues = ['comet-blaster', 'asteroid-burst', 'hyperdrive-charge', 'engine-drone', 'creature-call'].map(n => makeCue(example(n), project, 4242, -9));

describe.skipIf(!(await chromiumAvailable()))('baked vs runtime voice, in Chromium', () => {
  it('meets what every case owes, is deterministic over repeats, and the comparison can fail', async () => {
    const [chromium] = await runParity({ cues, engines: ['chromium'], runs: 2 });
    const at = (cue: string, label: string): CaseReport => chromium.cases.find(c => c.cue === cue && c.case === label)!;
    expect(chromium.cases.length).toBeGreaterThanOrEqual(cues.length * 4);
    for (const c of chromium.cases) {
      expect(c.distinct, `${c.cue} / ${c.case}`).toEqual({ baked: 1, runtime: 1 });
      expect(c.control.bitExact, `${c.cue} / ${c.case}: a different seed must render differently`).toBe(false);
      expect(c.hostEqualsHarness, `${c.cue} / ${c.case}: the harness bake is the production bake`).toBe(true);
      expect(c.pass, `${c.cue} / ${c.case} (${c.expect})`).toBe(true);
    }
    // Static bindings, every source type including `voice`: bit-exact on both taps.
    for (const cue of ['comet-blaster', 'asteroid-burst', 'hyperdrive-charge', 'creature-call']) {
      for (const label of ['defaults', 'variant 2, other seed', 'inputs at min']) {
        const c = at(cue, label);
        expect(c.runtime.delivered.bitExact, `${cue} / ${label}`).toBe(true);
        expect(c.runtime.authored.bitExact, `${cue} / ${label} authored`).toBe(true);
      }
    }
    // The held, live-bound engine bed is the baked sound to the bit at its defaults, and a continuous detune of a bake once the scale
    // stops quantising the bake. With the scale on, the bake snaps and the live voice cannot: that is the by-design case.
    const live = at('engine-drone', 'inputs at max, no scale snap');
    expect(live.runtime.delivered.maxAbsDb).toBeLessThan(-75);
    expect(live.runtime.delivered.correlation).toBeGreaterThan(0.99999);
    expect(at('engine-drone', 'inputs at max').runtime.delivered.maxAbsDb).toBeGreaterThan(-20);
    // The shared bus: a different summing order, the same sound.
    expect(at('comet-blaster', 'shared reverb bus').runtime.delivered.maxAbsDb).toBeLessThan(-100);
  }, 300_000);

  it('moves a live input mid-note without a click and arrives where a static bake would', async () => {
    // One voice: with the unison stack the beat phase differs between a voice that was glided and one that was born there.
    const p = structuredClone(example('engine-drone')) as any;
    p.layers[0].source.unison = { voices: 1, detuneCents: 0 };
    const r = parsePatch(p);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const rep = await runLive(makeCue(r.patch, project, 4242, -9), { input: 'speed', to: 1, at: 0.5, tau: 0.03 });
    expect(rep.finite).toBe(true);
    expect(rep.stepRatio).toBeLessThan(1.5);
    expect(rep.before.live.pitchHz).toBeCloseTo(rep.before.staticBake.pitchHz!, 0);
    expect(Math.abs(rep.after.live.pitchHz! - rep.after.staticBake.pitchHz!)).toBeLessThan(0.5);
    expect(rep.after.live.pitchHz!).toBeGreaterThan(90);
    expect(Math.abs(rep.after.live.momentaryMaxLufs! - rep.after.staticBake.momentaryMaxLufs!)).toBeLessThan(0.1);
    expect(Math.abs(rep.after.live.centroidHz! - rep.after.staticBake.centroidHz!)).toBeLessThan(3);
  }, 120_000);
});
