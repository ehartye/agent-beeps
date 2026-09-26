import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../../src/project.ts';
import { resolveInstruments } from '../../src/music.ts';
import { PAD, song } from '../helpers/songs.ts';

const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-inst-')));

describe('song instruments', () => {
  it('resolves song-level instruments by name, and library ones with overrides', () => {
    const s = song({
      instruments: {
        'my-pad': { layers: PAD.layers, duration: 1 },
        'high-warm': { base: 'warm-pad', set: { '/layers/1/source/pitch': 'C5' } },
      },
      tracks: { pad: { instrument: 'my-pad' }, hat: { instrument: 'high-warm' } },
    });
    const inst = resolveInstruments(p, s);
    expect(inst.pad.layers[0].source).toMatchObject({ type: 'osc', wave: 'sawtooth' });
    expect(inst.hat.layers[1].source).toMatchObject({ pitch: 'C5' });
    expect(inst.hat.name).toBe('high-warm');
  });

  it('accepts an override directly on a track', () => {
    const s = song({ tracks: { pad: { instrument: { base: 'glass-pad', set: { '/layers/0/filter/cutoff': 900 } } }, hat: { instrument: 'hat' } } });
    expect(resolveInstruments(p, s).pad.layers[0].filter).toMatchObject({ cutoff: 900 });
  });

  it('points at a bad override and an unknown base', () => {
    const bad = song({ tracks: { pad: { instrument: { base: 'glass-pad', set: { '/layers/0/amp/attack': -1 } } }, hat: { instrument: 'hat' } } });
    expect(() => resolveInstruments(p, bad)).toThrow(expect.objectContaining({ pointer: '/tracks/pad/instrument/layers/0/amp/attack' }));
    const missing = song({ tracks: { pad: { instrument: { base: 'nope' } }, hat: { instrument: 'hat' } } });
    expect(() => resolveInstruments(p, missing)).toThrow(/no instrument "nope"/);
  });
});
