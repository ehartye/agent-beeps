import { describe, expect, it } from 'vitest';
import { chromiumAvailable } from '../../src/render/host.ts';
import { makeCue } from '../../src/runtime/cue.ts';
import { runParity, checkParity, runPerf, runLive, renderKinds } from '../../src/runtime/harness.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { sampleFixture } from '../helpers/samples.ts';

describe.skipIf(!(await chromiumAvailable()))('sample production/runtime parity', () => {
  it.each([false, true])('keeps both taps exact, the production host equal, and changed source control effective (hybrid=%s)', async hybrid => {
    const f = sampleFixture({ hybrid }), cue = makeCue(f.patch, defaultProject(), 4242, -9);
    const [r] = await runParity({ cues: [cue], engines: ['chromium'], runs: 2, sampleWavs: f.sampleWavs, cases: () => [{ label: 'defaults', params: {}, variant: 0, seed: cue.seed }] });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]).toMatchObject({ pass: true, hostEqualsHarness: true, controlKind: 'sample-content', distinct: { baked: 1, runtime: 1 } });
    expect(r.cases[0].runtime.delivered.bitExact).toBe(true);
    expect(r.cases[0].runtime.authored.bitExact).toBe(true);
    expect(r.cases[0].control.bitExact).toBe(false);
    const verified = await checkParity([cue], ['chromium'], { sampleWavs: f.sampleWavs });
    expect(verified.verdicts).toMatchObject([{ ok: true, mode: 'exact' }]);
  }, 120000);
  it('uses a changed-content control that detects an all-zero recording', async () => {
    const f = sampleFixture({ zero: true }), cue = makeCue(f.patch, defaultProject(), 1, -9);
    const [r] = await runParity({ cues: [cue], engines: ['chromium'], runs: 1, sampleWavs: f.sampleWavs, cases: () => [{ label: 'zero', params: {}, variant: 0, seed: 1 }] });
    expect(r.cases[0].control.bitExact).toBe(false);
  }, 120000);
  it('preloads outside voice timing and reuses prepared buffers for warm sample builds', async () => {
    const f = sampleFixture(), cue = makeCue(f.patch, defaultProject(), 1, -9);
    const [r] = await runPerf([cue], { n: 4, sampleWavs: f.sampleWavs });
    expect(r.warmCounts.buffers).toBe(0);
    expect(r.warmCounts.bufferBytes).toBe(0);
    expect(r.warmCounts.nodes).toBeGreaterThan(0);
  }, 120000);
  it('preloads for spot checks and live level control, arriving at the static bake level', async () => {
    const f = sampleFixture({ live: true }), cue = makeCue(f.patch, defaultProject(), 1, -9);
    const r = await renderKinds(cue, {}, { sampleWavs: f.sampleWavs });
    expect(r.baked.authored).toEqual(r.runtime.authored);
    const live = await runLive(cue, { input: 'level', to: 1, at: 0.3, tau: 0.01 }, { sampleWavs: f.sampleWavs });
    expect(live.finite).toBe(true);
    expect(Math.abs(live.after.live.momentaryMaxLufs! - live.after.staticBake.momentaryMaxLufs!)).toBeLessThan(0.1);
    expect(live.after.live.momentaryMaxLufs!).toBeLessThan(live.before.live.momentaryMaxLufs! - 11);
  }, 120000);
});
