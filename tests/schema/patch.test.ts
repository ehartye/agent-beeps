import { describe, expect, it } from 'vitest';
import { parsePatch, patchJsonSchema } from '../../src/schema/patch.ts';
import { parseProject, defaultProject } from '../../src/schema/project.ts';
import { coin } from '../helpers/patches.ts';

describe('patch@1', () => {
  it('accepts a minimal patch and fills defaults', () => {
    const r = parsePatch({ schema: 'beeps/patch@1', name: 'coin', family: 'coin', duration: 0.4,
      layers: [{ source: { type: 'osc', wave: 'square', pitch: 'E6' }, amp: { attack: 0.004, decay: 0.18 } }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.tags).toEqual([]);
    expect(r.patch.layers[0].amp.sustain).toBe(0);
    expect(r.patch.layers[0].gainDb).toBe(0);
  });

  it('points at q on a lowpass and hints resonanceDb', () => {
    const bad: any = coin();
    bad.layers[0].filter = { type: 'lowpass', cutoff: 2000, q: 3 };
    const r = parsePatch(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({ pointer: '/layers/0/filter', hint: expect.stringMatching(/resonanceDb/) });
  });

  it('points at a bad note name', () => {
    const bad: any = coin();
    bad.layers[0].source.pitch = 'H9';
    const r = parsePatch(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].pointer).toBe('/layers/0/source/pitch');
  });

  it('refuses loudness literals with a hint', () => {
    const bad: any = coin();
    bad.layers[0].volume = 0.5;
    const r = parsePatch(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].hint).toMatch(/loudness/);
  });

  it('accepts every source type', () => {
    const sources = [
      { type: 'noise', color: 'pink' },
      { type: 'fm', pitch: 220, operators: [{ ratio: 1 }, { ratio: 2, index: 3 }], algorithm: [[1, 0]] },
      { type: 'additive', pitch: 440, partials: [[1, 0, 0.5], [2, -6, 0.3]] },
      { type: 'modal', pitch: 600, modes: [[1, 30, 0], [2.76, 40, -6]], exciter: 'impulse' },
      { type: 'grains', rate: 80, grainDecay: 0.004, center: 3000, q: 2 },
      { type: 'metal', bands: [3440, 7100] },
      { type: 'osc', wave: 'sawtooth', pitch: 110, unison: { voices: 3, detuneCents: 20 } },
    ];
    for (const source of sources) {
      const r = parsePatch({ ...coin(), layers: [{ source, amp: { attack: 0.001, decay: 0.1 } }] });
      expect(r.ok, `${source.type}: ${JSON.stringify(!r.ok && r.issues)}`).toBe(true);
    }
  });

  it('rejects an unknown source type with the list of types', () => {
    const r = parsePatch({ ...coin(), layers: [{ source: { type: 'sampler' }, amp: { attack: 0.01, decay: 0.1 } }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0].pointer).toBe('/layers/0/source/type');
      expect(r.issues[0].hint).toMatch(/modal/);
    }
  });

  it('exports a JSON Schema', () => {
    expect(patchJsonSchema()).toHaveProperty('$schema');
  });
});

describe('project@1', () => {
  it('defaults to C major pentatonic at -18 LUFS', () => {
    expect(defaultProject()).toMatchObject({ scale: { root: 'C', mode: 'majorPentatonic', snap: true }, targetLoudness: -18, sampleRate: 48000 });
    expect(parseProject({ schema: 'beeps/project@1' }).targetLoudness).toBe(-18);
  });
});
