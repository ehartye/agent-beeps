import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPatch } from '../../runtime/engine/patch.js';
import { loadArchetypes, sampleArchetype } from '../../src/archetypes.ts';
import { lintPatch } from '../../src/lint.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import { renderAndMeasure } from '../../src/render/pipeline.ts';
import { parsePatch } from '../../src/schema/patch.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch, withSource } from '../helpers/patches.ts';

const VOICE = { type: 'voice', pitch: 100, formants: [[800, 15, 0], [2500, 15, 0]] };
const raw = (source: unknown) => ({ schema: 'beeps/patch@1', name: 'v', family: 'creature', duration: 0.5, layers: [{ source, amp: {} }] });
const CREATURES = loadArchetypes().filter(a => a.family === 'creature');

describe('voice source: schema', () => {
  it('accepts 2-4 formants with defaults, and every optional modulation', () => {
    const r = parsePatch(raw(VOICE));
    expect(r.ok && r.patch.layers[0].source).toMatchObject({ tilt: 1.5, jitterCents: 0, breath: 0 });
    expect(parsePatch(raw({ ...VOICE, formants: [[500, 5, 0], [1000, 5, 0], [2000, 5, 0], [3000, 5, 0]], vibrato: { rate: 5, cents: 30 }, tremolo: { rate: 30, depth: 0.5 }, jitterCents: 10, breath: 0.2, tilt: 2 })).ok).toBe(true);
  });
  it('rejects one or five formants, out-of-range modulation and unknown keys', () => {
    expect(parsePatch(raw({ ...VOICE, formants: [[800, 15, 0]] })).ok).toBe(false);
    expect(parsePatch(raw({ ...VOICE, formants: Array(5).fill([800, 15, 0]) })).ok).toBe(false);
    expect(parsePatch(raw({ ...VOICE, breath: 1.5 })).ok).toBe(false);
    expect(parsePatch(raw({ ...VOICE, tremolo: { rate: 30, depth: 2 } })).ok).toBe(false);
    expect(parsePatch(raw({ ...VOICE, vowel: 'a' })).ok).toBe(false);
  });
});

describe('voice source: graph', () => {
  const build = (extra: Record<string, unknown> = {}) => {
    const f = new FakeContext();
    buildPatch(asCtx(f), withSource({ ...VOICE, ...extra }), { seed: 1 });
    return f;
  };
  it('is one periodic-wave oscillator into one bandpass per formant', () => {
    const f = build();
    const [pulse] = f.nodes('osc');
    expect(f.count('osc')).toBe(1);
    expect(pulse.wave.imag[1]).toBe(1);
    expect(pulse.wave.imag[2]).toBeCloseTo(1 / 2 ** 1.5, 6);
    expect(f.nodes('biquad').map(b => [b.type, b.frequency.value, b.Q.value])).toEqual([['bandpass', 800, 15], ['bandpass', 2500, 15]]);
  });
  it('adds vibrato, tremolo, jitter and breath nodes only when asked', () => {
    expect(build().count('bufferSource')).toBe(0);
    const f = build({ vibrato: { rate: 6, cents: 20 }, tremolo: { rate: 30, depth: 0.5 }, jitterCents: 10, breath: 0.3 });
    expect(f.count('osc')).toBe(3);
    expect(f.count('bufferSource')).toBe(2);
    expect(f.maxFanIn()).toBeLessThanOrEqual(2);
  });
  it('follows the pitch envelope with the pulse train only, not the formants', () => {
    const f = new FakeContext();
    buildPatch(asCtx(f), patch(raw({ ...VOICE })), { seed: 1 });
    const g = new FakeContext();
    const p = patch({ ...raw(VOICE), layers: [{ source: VOICE, pitchEnv: [{ at: 0.2, to: 200 }], amp: {} }] });
    buildPatch(asCtx(g), p, { seed: 1 });
    expect(g.nodes('osc')[0].frequency.events.length).toBeGreaterThan(0);
    expect(g.nodes('biquad').every(b => b.frequency.events.length === 0)).toBe(true);
  });
});

describe('creature archetypes', () => {
  it('are voice-based, in family creature, and sample schema-valid patches', () => {
    expect(CREATURES.map(a => a.name)).toEqual(['creature', 'creature-bleat', 'creature-cluck', 'creature-growl', 'creature-hiss', 'creature-huff', 'creature-low', 'creature-yip']);
    for (const a of CREATURES) {
      expect(a.template.layers.every(l => l.source.type === 'voice'), a.name).toBe(true);
      for (const p of sampleArchetype(a, 5, 30)) expect(parsePatch(p).ok, p.name).toBe(true);
    }
  });
});

describe.skipIf(!(await chromiumAvailable()))('voice source: rendered', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  /** Magnitude of the signal at `hz` (single-bin DFT). */
  const mag = (x: Float32Array, hz: number, sr = 48000) => {
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i++) { const a = (2 * Math.PI * hz * i) / sr; re += x[i] * Math.cos(a); im += x[i] * Math.sin(a); }
    return Math.hypot(re, im);
  };
  /** Mean power over the bins within `half` Hz of `centre`. */
  const band = (x: Float32Array, centre: number, half = 150) => {
    let s = 0, n = 0;
    for (let hz = centre - half; hz <= centre + half; hz += 25) { s += mag(x, hz) ** 2; n++; }
    return s / n;
  };

  it('is non-silent, has energy at its formants and a valley between them', async () => {
    const [r] = await host.render([{ patch: withSource({ ...VOICE, tilt: 1 }, { amp: { attack: 0.01, decay: 0, sustain: 1, release: 0.01 } }), opts: { seed: 1 } }]);
    if (!r.ok) throw new Error(r.error);
    const x = r.authored[0].slice(4800, 4800 + 24000);
    expect(x.some(v => Math.abs(v) > 0.01)).toBe(true);
    expect(band(x, 800)).toBeGreaterThan(band(x, 1600) * 4);
    expect(band(x, 2500)).toBeGreaterThan(band(x, 1600) * 2);
    expect(band(x, 800)).toBeGreaterThan(band(x, 5000) * 20);
  });

  it('renders the same samples twice for a seed, jitter and breath included', async () => {
    const p = withSource({ ...VOICE, jitterCents: 30, breath: 0.4, vibrato: { rate: 6, cents: 30 }, tremolo: { rate: 20, depth: 0.5 } });
    const [a, b] = await host.render([{ patch: p, opts: { seed: 3 } }, { patch: p, opts: { seed: 3 } }]);
    if (!a.ok || !b.ok) throw new Error('render failed');
    expect(Buffer.from(a.authored[0].buffer, a.authored[0].byteOffset, a.authored[0].byteLength).equals(Buffer.from(b.authored[0].buffer, b.authored[0].byteOffset, b.authored[0].byteLength))).toBe(true);
    expect(a.authored[0].some(v => v !== 0)).toBe(true);
  });

  it('every sampled creature candidate renders and passes the error-level craft lint', async () => {
    const project = defaultProject();
    const dir = mkdtempSync(join(tmpdir(), 'beeps-creature-'));
    const patches = CREATURES.flatMap(a => sampleArchetype(a, 2026, 12));
    const out = await renderAndMeasure(host, patches.map(p => ({ patch: p })), { project, rendersDir: dir });
    for (const r of out) {
      if (!r.ok) throw new Error(`${r.patchName}: ${r.error}`);
      expect(lintPatch(r.patch, r.features, project).errors.map(e => `${r.patch.name} ${e.rule}: ${e.message}`)).toEqual([]);
    }
  }, 300000);
});
