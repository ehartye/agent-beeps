// Characterization of the engine's pitch parsing and transposition. The oracles below are verbatim copies of the code
// that params.js and song.js carried before the shared helpers existed; every assertion is bit-for-bit (`toEqual` on
// numbers is `Object.is`), so a refactor of either file cannot move a rendered pitch.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noteToHz } from '../../runtime/engine/notes.js';
import { applyParams } from '../../runtime/engine/params.js';
import { transposePatch } from '../../runtime/engine/song.js';
import { coin, patch, tone, withSource } from '../helpers/patches.ts';

// --- oracles: the pre-refactor implementations -------------------------------------------------------------------

const oldHz = (p: string | number): number => {
  if (typeof p === 'number') return p;
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(p);
  if (!m) return NaN;
  const semi = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C'] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * 2 ** ((12 * (Number(m[3]) + 1) + semi - 69) / 12);
};

function oldParamsTranspose(p: any, r: number) {
  for (const l of p.layers) {
    const s = l.source;
    if ('pitch' in s) s.pitch = oldHz(s.pitch) * r;
    if (s.type === 'metal') s.base *= r;
    if (l.pitchEnv) for (const e of l.pitchEnv) e.to = oldHz(e.to) * r;
  }
}

function oldTransposePatch(p: any, semitones: number, keytrack: number, duration: number | null) {
  const ratio = 2 ** (semitones / 12);
  const fRatio = ratio ** keytrack;
  const out = structuredClone(p);
  if (duration !== null) out.duration = Math.max(0.01, duration);
  if (!semitones) return out;
  for (const l of out.layers) {
    const src = l.source;
    if ('pitch' in src) src.pitch = noteToHz(src.pitch) * ratio;
    if (l.pitchEnv) for (const pt of l.pitchEnv) pt.to = noteToHz(pt.to) * ratio;
    if (l.filter && keytrack) {
      l.filter.cutoff = Math.min(22000, l.filter.cutoff * fRatio);
      if (l.filter.env) l.filter.env.to = Math.min(22000, l.filter.env.to * fRatio);
    }
  }
  return out;
}

// --- fixtures ----------------------------------------------------------------------------------------------------

const library = (() => {
  const dir = join(import.meta.dirname, '..', '..', 'library', 'instruments');
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => [f.replace(/\.json$/, ''), patch(JSON.parse(readFileSync(join(dir, f), 'utf8')))] as const);
})();

const bright = patch({
  schema: 'beeps/patch@1', name: 'bright', family: 'test', duration: 0.4,
  layers: [{
    source: { type: 'osc', wave: 'sawtooth', pitch: 'A3' },
    pitchEnv: [{ at: 0.05, to: 'C#4' }, { at: 0.1, to: 220.5 }],
    amp: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.1 },
    filter: { type: 'lowpass', cutoff: 15000, resonanceDb: 2, env: { to: 20000, time: 0.2 } },
  }],
});

const handBuilt = [
  ['coin (note names, pitchEnv, lowpass)', coin()],
  ['tone (Hz number pitch)', tone('sine', 523.25)],
  ['metal (base, no pitch)', withSource({ type: 'metal', base: 300 })],
  ['keytracked filter near the ceiling', bright],
] as const;
const patches = [...library.map(([n, p]) => [`instrument ${n}`, p] as const), ...handBuilt];

const NOTE_NAMES = (['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const).flatMap(l => ['', '#', 'b'].flatMap(a => Array.from({ length: 19 }, (_, i) => `${l}${a}${i - 9}`)));

const bound = (p: any, target: string, hi: number, unit?: string) => ({
  ...structuredClone(p),
  xRuntime: { inputs: { x: { min: 0, max: 1, default: 0 } }, bind: [{ input: 'x', target, range: [0, hi], ...(unit ? { unit } : {}) }] },
});
const apply = (p: any, target: string, hi: number, unit?: string) => applyParams(bound(p, target, hi, unit), { x: 1 }).patch as any;

// --- step 1: pitch parsing ---------------------------------------------------------------------------------------

describe('pitch parsing in params.js agrees with noteToHz', () => {
  it('matches the old parser bit for bit on every spelling the schema accepts (A-G, natural/#/b, octaves -9..9)', () => {
    expect(NOTE_NAMES).toHaveLength(7 * 3 * 19);
    for (const n of NOTE_NAMES) expect(noteToHz(n), n).toBe(oldHz(n));
  });

  it('a pitch binding reads note names and Hz numbers exactly as before', () => {
    for (const n of [...NOTE_NAMES, 440, 523.25, 27.5, 0.5]) {
      const p = withSource({ type: 'osc', wave: 'sine', pitch: n });
      expect((apply(p, '/layers/0/source/pitch', 7, 'st')).layers[0].source.pitch, String(n)).toBe(oldHz(n) * 2 ** (7 / 12));
      expect((apply(p, '/layers/0/source/pitch', 1)).layers[0].source.pitch, String(n)).toBe(oldHz(n) * 2 ** 1);
    }
  });

  it('a pitchEnv target binding reads note names exactly as before', () => {
    const p = coin();
    expect(apply(p, '/layers/0/pitchEnv/0/to', 5, 'st').layers[0].pitchEnv[0].to).toBe(oldHz('B6') * 2 ** (5 / 12));
  });

  it('/out/transpose reads note names and Hz numbers exactly as before', () => {
    for (const n of NOTE_NAMES) {
      const p = withSource({ type: 'osc', wave: 'sine', pitch: n });
      expect(apply(p, '/out/transpose', 7).layers[0].source.pitch, n).toBe(oldHz(n) * 2 ** (7 / 12));
    }
    expect(apply(tone('sine', 523.25), '/out/transpose', 7).layers[0].source.pitch).toBe(523.25 * 2 ** (7 / 12));
  });

  it('an unparseable name throws like noteToHz (it used to propagate NaN)', () => {
    const p = withSource({ type: 'osc', wave: 'sine', pitch: 'E6' });
    p.layers[0].source = { ...p.layers[0].source, pitch: 'H2' } as any;
    expect(() => apply(p, '/layers/0/source/pitch', 7, 'st')).toThrow(/Unknown note "H2"/);
  });
});

// --- step 2: transposition ---------------------------------------------------------------------------------------

describe('params.js /out/transpose', () => {
  it.each(patches)('%s: moves every pitched thing exactly as before', (_n, p) => {
    for (const d of [-12, -5, 3, 7, 12]) {
      const want = bound(p, '/out/transpose', d);
      oldParamsTranspose(want, 2 ** (d / 12));
      expect(apply(p, '/out/transpose', d)).toEqual(want);
    }
  });

  it('shifts metal.base and nothing else about a metal source', () => {
    const out = apply(withSource({ type: 'metal', base: 300 }), '/out/transpose', 12);
    expect(out.layers[0].source.base).toBe(300 * 2 ** (12 / 12));
    expect('pitch' in out.layers[0].source).toBe(false);
  });

  it('leaves filter cutoffs alone (no keytrack, no ceiling)', () => {
    const out = apply(bright, '/out/transpose', 12);
    expect(out.layers[0].filter.cutoff).toBe(15000);
    expect(out.layers[0].filter.env.to).toBe(20000);
  });
});

describe('song.js transposePatch', () => {
  it.each(patches)('%s: moves pitches and keytracked cutoffs exactly as before', (_n, p) => {
    for (const semis of [0, -12, -5, 3, 7, 12, 19])
      for (const kt of [0, 0.5, 1])
        for (const dur of [null, 0.002, 0.7]) expect(transposePatch(p, semis, kt, dur)).toEqual(oldTransposePatch(p, semis, kt, dur));
  });

  it('does not shift metal.base', () => {
    const p = withSource({ type: 'metal', base: 300 });
    expect((transposePatch(p, 12, 1, null).layers[0].source as any).base).toBe(300);
  });

  it('clamps keytracked cutoffs at 22 kHz, and leaves a zero shift untouched', () => {
    const up = transposePatch(bright, 12, 1, null).layers[0].filter!;
    expect(up.cutoff).toBe(22000);
    expect(up.env!.to).toBe(22000);
    expect(transposePatch(bright, 0, 1, null)).toEqual(bright);
    expect((transposePatch(bright, 0, 1, null).layers[0].source as any).pitch).toBe('A3');
  });
});
