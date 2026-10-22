import { describe, expect, it } from 'vitest';
import { noticeField, notice, NOTICE_CODES, NOTICE_REGISTRY } from '../src/notices.ts';
import { scaleSnapNotices, variantsIdentical, variantNotices } from '../src/patch-notices.ts';
import { defaultProject } from '../src/schema/project.ts';
import { coin, patch } from './helpers/patches.ts';

const pentatonic = defaultProject().scale; // C majorPentatonic, snapping
const free = { ...pentatonic, snap: false };

describe('notices', () => {
  it('builds a notice from its code, taking severity and hint from the registry', () => {
    const n = notice('N_SCALE_SNAP', { message: 'layer 0 pitch 466 Hz renders as A#4', pointer: '/layers/0/source/pitch', requested: 466, applied: 'A#4' });
    expect(n).toMatchObject({ code: 'N_SCALE_SNAP', severity: 'warn', pointer: '/layers/0/source/pitch', requested: 466, applied: 'A#4' });
    expect(n.hint).toMatch(/scale/);
  });

  it('lets a caller override the registry hint, and omits fields it was not given', () => {
    const n = notice('N_SCALE_SNAP', { message: 'm', hint: 'custom' });
    expect(n.hint).toBe('custom');
    expect(Object.keys(notice('N_SCALE_SNAP', { message: 'm' })).sort()).toEqual(['code', 'hint', 'message', 'severity']);
  });

  it('documents every code with a summary and a default hint', () => {
    expect(NOTICE_CODES.length).toBeGreaterThan(0);
    for (const code of NOTICE_CODES) {
      expect(code).toMatch(/^N_[A-Z0-9_]+$/);
      expect(NOTICE_REGISTRY[code].summary.length, code).toBeGreaterThan(10);
      expect(NOTICE_REGISTRY[code].hint.length, code).toBeGreaterThan(10);
      expect(['info', 'warn']).toContain(NOTICE_REGISTRY[code].severity);
    }
  });

  it('adds a notices field only when there is something to say', () => {
    expect(noticeField([])).toEqual({});
    const n = notice('N_SCALE_SNAP', { message: 'm' });
    expect(noticeField([n])).toEqual({ notices: [n] });
  });
});

describe('scale snap', () => {
  it('reports a layer whose pitch the project scale moves', () => {
    const p = patch({ schema: 'beeps/patch@1', name: 'snapped', family: 'test', duration: 0.3, layers: [{ source: { type: 'osc', wave: 'sine', pitch: 466 }, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } }] });
    const [n, ...rest] = scaleSnapNotices(p, pentatonic);
    expect(rest).toEqual([]);
    expect(n).toMatchObject({ code: 'N_SCALE_SNAP', severity: 'warn', pointer: '/layers/0/source/pitch', requested: 466 });
    expect(typeof n.applied).toBe('string');
    expect(n.message).toMatch(/466/);
  });

  it('reports a pitch envelope target the scale moves, with its own pointer', () => {
    const p = patch({ schema: 'beeps/patch@1', name: 'sweep', family: 'test', duration: 0.3, layers: [{ source: { type: 'osc', wave: 'sine', pitch: 'C4' }, pitchEnv: [{ at: 0.05, to: 466, curve: 'step' }], amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } }] });
    expect(scaleSnapNotices(p, pentatonic).map(n => n.pointer)).toEqual(['/layers/0/pitchEnv/0/to']);
  });

  it('is silent when the pitch is already in the scale, or when the scale does not snap', () => {
    expect(scaleSnapNotices(coin(), { ...pentatonic, root: 'E', mode: 'chromatic' })).toEqual([]);
    expect(scaleSnapNotices(patch({ schema: 'beeps/patch@1', name: 'free', family: 'test', duration: 0.3, layers: [{ source: { type: 'osc', wave: 'sine', pitch: 466 }, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } }] }), free)).toEqual([]);
  });

  it('ignores sources with no pitch, and differences under a cent', () => {
    const noise = patch({ schema: 'beeps/patch@1', name: 'hiss', family: 'test', duration: 0.3, layers: [{ source: { type: 'noise', color: 'white' }, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } }] });
    expect(scaleSnapNotices(noise, pentatonic)).toEqual([]);
    const exact = patch({ schema: 'beeps/patch@1', name: 'exact', family: 'test', duration: 0.3, layers: [{ source: { type: 'osc', wave: 'sine', pitch: 261.63 }, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } }] });
    expect(scaleSnapNotices(exact, pentatonic)).toEqual([]);
  });
});

describe('variants that render the same', () => {
  const withVariation = (variation: Record<string, unknown>, source: Record<string, unknown> = { type: 'osc', wave: 'sine', pitch: 'C4' }) =>
    patch({ schema: 'beeps/patch@1', name: 'v', family: 'test', duration: 0.3, variation, layers: [{ source, amp: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.05 } }] });

  it('is true when several variants are declared with no pitch spread and no gain spread', () => {
    expect(variantsIdentical(withVariation({ variants: 4 }))).toBe(true);
  });

  it('is false when a spread moves the sound', () => {
    expect(variantsIdentical(withVariation({ variants: 4, gainDb: 1 }))).toBe(false);
    expect(variantsIdentical(withVariation({ variants: 4, pitchCents: 20 }))).toBe(false);
  });

  it('is true when the only spread is pitch and no layer is pitched', () => {
    expect(variantsIdentical(withVariation({ variants: 4, pitchCents: 20 }, { type: 'noise', color: 'white' }))).toBe(true);
  });

  it('is false for one variant, or no variation block', () => {
    expect(variantsIdentical(withVariation({ variants: 1 }))).toBe(false);
    expect(variantsIdentical(coin())).toBe(false);
  });

  it('turns that into a notice, and says when a variant request has nothing to vary', () => {
    expect(variantNotices(withVariation({ variants: 4 })).map(n => n.code)).toEqual(['N_VARIANTS_IDENTICAL']);
    expect(variantNotices(coin(), { requested: true }).map(n => n.code)).toEqual(['N_NO_VARIANTS']);
    expect(variantNotices(coin())).toEqual([]);
  });
});
