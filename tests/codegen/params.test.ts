import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyParams, bd, defaultParams, unitOf } from '../../runtime/engine/params.js';
import { patchRenderKey } from '../../src/render/pipeline.ts';
import { parsePatch, patchJsonSchema, runtimeIssues } from '../../src/schema/patch.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { coin, patch } from '../helpers/patches.ts';

const base = () => ({ ...coin() } as Record<string, any>);
const withRuntime = (xRuntime: unknown, extra: Record<string, unknown> = {}) => parsePatch({ ...base(), ...extra, xRuntime });
const issues = (r: ReturnType<typeof parsePatch>) => (r.ok ? [] : r.issues);

describe('the xRuntime block does not touch existing patches', () => {
  it('parses every shipped patch without an xRuntime block, and still parses them', () => {
    const dirs = ['library/sounds/sci-fi/patches', 'library/instruments'].map(d => join(import.meta.dirname, '..', '..', d));
    const files = dirs.flatMap(d => readdirSync(d).filter(f => f.endsWith('.json')).map(f => join(d, f)));
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      if (raw.schema !== 'beeps/patch@1') continue;
      const r = parsePatch(raw);
      expect(r.ok, f).toBe(true);
      if (r.ok) expect('xRuntime' in r.patch, f).toBe(false);
    }
  });

  it('keeps the baked render key when bindings are added, removed or edited', () => {
    const project = defaultProject();
    const plain = patch(base());
    const bound = patch({ ...base(), xRuntime: { inputs: { size: { min: 0, max: 1, default: 0.5 } }, bind: [{ input: 'size', target: '/out/transpose', range: [3, -3] }] } });
    const edited = patch({ ...base(), xRuntime: { inputs: { size: { min: 0, max: 1, default: 0.5 } }, bind: [{ input: 'size', target: '/out/transpose', range: [7, -7] }] } });
    const k = (p: typeof plain) => patchRenderKey(p, project, 1, 0);
    expect(k(bound)).toBe(k(plain));
    expect(k(edited)).toBe(k(plain));
  });

  it('is in the published JSON Schema, marked experimental by its name', () => {
    const props = (patchJsonSchema() as any).properties;
    expect(props.xRuntime).toBeTruthy();
  });
});

describe('bd: the delta a binding contributes', () => {
  it('is zero at the default and at an absent value, and linear between', () => {
    expect(bd(0.5, 0.5, 0, 1, -6, 6)).toBe(0);
    expect(bd(undefined, 0.5, 0, 1, -6, 6)).toBe(0);
    expect(bd(1, 0.5, 0, 1, -6, 6)).toBeCloseTo(6);
    expect(bd(0, 0.5, 0, 1, -6, 6)).toBeCloseTo(-6);
    expect(bd(0.75, 0.5, 0, 1, -6, 6)).toBeCloseTo(3);
  });
  it('clamps a value outside the range, and shapes the curve', () => {
    expect(bd(9, 0, 0, 1, 0, 10)).toBe(10);
    expect(bd(0.5, 0, 0, 1, 0, 10, 'quad')).toBeCloseTo(2.5);
    expect(bd(0.25, 0, 0, 1, 0, 10, 'sqrt')).toBeCloseTo(5);
  });
});

describe('applyParams', () => {
  const p = patch({
    ...base(),
    layers: [{ source: { type: 'osc', wave: 'square', pitch: 'E6' }, gainDb: -3, pan: 0.2, pitchEnv: [{ at: 0.06, to: 'B6', curve: 'step' }], amp: { attack: 0.004, decay: 0.12, sustain: 0, release: 0.05 }, filter: { type: 'lowpass', cutoff: 6000, resonanceDb: 0 } }],
    xRuntime: {
      inputs: { size: { min: 0, max: 1, default: 0.5 }, dist: { min: 0, max: 1, default: 0 } },
      bind: [
        { input: 'size', target: '/out/transpose', range: [12, -12] },
        { input: 'dist', target: '/out/gainDb', range: [0, -20] },
        { input: 'dist', target: '/out/brightness', range: [0, -1] },
        { input: 'dist', target: '/layers/0/gainDb', range: [0, -6] },
        { input: 'dist', target: '/layers/0/pan', range: [0, 0.5] },
      ],
    },
  });

  it('returns the very same patch at the defaults', () => {
    expect(applyParams(p, {}).patch).toEqual(p);
    expect(applyParams(p, defaultParams(p))).toEqual({ patch: p, trimDeltaDb: 0 });
  });
  it('does not modify the patch it was given', () => {
    const before = JSON.stringify(p);
    applyParams(p, { size: 1, dist: 1 });
    expect(JSON.stringify(p)).toBe(before);
  });
  it('transposes every pitch, including the pitch envelope, by the semitones the binding gives', () => {
    const a = applyParams(p, { size: 1 }).patch.layers[0] as any;
    // range 12 at 0 and -12 at 1, default 0.5 (value 0): size 1 is 12 semitones down from the default, one octave.
    expect(a.source.pitch).toBeCloseTo(1318.51 / 2, 1);
    expect(a.pitchEnv[0].to).toBeCloseTo(1975.53 / 2, 1);
  });
  it('moves cutoffs in octaves, gains in dB, pan additively, and reports the trim delta separately', () => {
    const { patch: a, trimDeltaDb } = applyParams(p, { dist: 1 });
    const l = a.layers[0];
    expect(l.filter!.cutoff).toBeCloseTo(3000, 3);
    expect(l.gainDb).toBeCloseTo(-9);
    expect(l.pan).toBeCloseTo(0.7);
    expect(trimDeltaDb).toBeCloseTo(-20);
  });
  it('leaves live bindings alone unless asked for them', () => {
    const live = patch({ ...base(), xRuntime: { inputs: { s: { min: 0, max: 1, default: 0 } }, bind: [{ input: 's', target: '/layers/0/gainDb', range: [0, -12], live: true }] } });
    expect(applyParams(live, { s: 1 }).patch.layers[0].gainDb).toBe(live.layers[0].gainDb);
    expect(applyParams(live, { s: 1 }, true).patch.layers[0].gainDb).toBeCloseTo(live.layers[0].gainDb - 12);
  });
  it('knows its units', () => {
    expect(unitOf('/layers/0/filter/cutoff')).toBe('oct');
    expect(unitOf('/layers/0/gainDb')).toBe('db');
    expect(unitOf('/layers/0/pan')).toBe('lin');
    expect(unitOf('/out/transpose')).toBe('st');
  });
});

describe('xRuntime is validated where the patch is parsed', () => {
  const inputs = { size: { min: 0, max: 1, default: 0.5 } };
  it('accepts a sound binding', () => {
    expect(withRuntime({ inputs, bind: [{ input: 'size', target: '/layers/0/filter/cutoff', range: [-1, 1] }] }).ok).toBe(true);
  });
  it('names an undeclared input', () => {
    const r = withRuntime({ inputs, bind: [{ input: 'speed', target: '/out/transpose', range: [0, 1] }] });
    expect(issues(r)[0]).toMatchObject({ pointer: '/xRuntime/bind/0/input' });
  });
  it('names a target the patch does not have', () => {
    const r = withRuntime({ inputs, bind: [{ input: 'size', target: '/layers/4/gainDb', range: [0, 1] }] });
    expect(issues(r)[0]).toMatchObject({ pointer: '/xRuntime/bind/0/target', message: expect.stringContaining('does not exist') });
  });
  it('refuses a live binding to something the graph does not automate', () => {
    const r = withRuntime({ inputs, bind: [{ input: 'size', target: '/layers/0/amp/decay', range: [0, 1], live: true }] });
    expect(issues(r)[0]).toMatchObject({ pointer: '/xRuntime/bind/0/live' });
  });
  it('catches an input range that makes the patch invalid at a corner, and accepts it with a clamp', () => {
    const bind = { input: 'size', target: '/layers/0/filter/cutoff', range: [0, 6] };
    expect(issues(withRuntime({ inputs, bind: [bind] }))[0]).toMatchObject({ pointer: '/xRuntime/bind', hint: expect.stringContaining('clamp') });
    expect(withRuntime({ inputs, bind: [{ ...bind, clamp: [20, 20000] }] }).ok).toBe(true);
  });
  it('rejects a default outside the range, and unknown keys', () => {
    expect(issues(withRuntime({ inputs: { size: { min: 0, max: 1, default: 2 } }, bind: [] }))[0]).toMatchObject({ pointer: '/xRuntime/inputs/size/default' });
    expect(withRuntime({ inputs, bind: [], extra: 1 }).ok).toBe(false);
  });
  it('exposes runtimeIssues for tools that hold a parsed patch', () => {
    expect(runtimeIssues(coin())).toEqual([]);
  });
});
