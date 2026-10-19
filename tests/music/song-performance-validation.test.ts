import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { initProject } from '../../src/project.ts';
import { resolveInstruments } from '../../src/music.ts';
import { PAD, song } from '../helpers/songs.ts';

const project = () => initProject(mkdtempSync(join(tmpdir(), 'beeps-expression-')));
const score = (instrument: unknown = PAD, velocityInput = 'touch', vel = 1) => song({
  tracks: { keys: { instrument, velocityInput } },
  patterns: { line: { bars: 1, notes: [[0, 'C4', 1, vel]] } },
  sections: { a: { bars: 1, play: { keys: 'line' } } }, form: ['a'],
});

it('reports an undeclared velocity input as an authoring error before launching a browser', () => {
  expect(() => resolveInstruments(project(), score())).toThrow(expect.objectContaining({ code: 'E_SCHEMA', pointer: '/tracks/keys/velocityInput' }));
});

it('refuses brightness gestures on an unfiltered instrument', () => {
  const s = song({ tracks: { keys: { instrument: { ...PAD, layers: [{ ...PAD.layers[0], filter: undefined }] } } },
    patterns: { line: { bars: 1, notes: [{ at: 0, note: 'C4', beats: 1, expression: { brightness: [[0, 0], [1, 1]] } }] } },
    sections: { a: { bars: 1, play: { keys: 'line' } } }, form: ['a'] });
  expect(() => resolveInstruments(project(), s)).toThrow(/brightness.*filter/i);
});

it('checks actual performed velocity against patch bounds, including nonlinear interior extrema', () => {
  const instrument = { ...PAD, layers: [{ ...PAD.layers[0], amp: { attack: .01, decay: .1, sustain: .7, release: 1 } }], xRuntime: {
    inputs: { touch: { min: 0, max: 1, default: 0 } },
    bind: [
      { input: 'touch', target: '/layers/0/amp/release', range: [0, -20] },
      { input: 'touch', target: '/layers/0/amp/release', range: [0, 20], shape: 'sqrt' },
    ],
  } };
  expect(() => resolveInstruments(project(), score(instrument, 'touch', 0))).not.toThrow();
  expect(() => resolveInstruments(project(), score(instrument, 'touch', 1))).not.toThrow();
  expect(() => resolveInstruments(project(), score(instrument, 'touch', .25))).toThrow(expect.objectContaining({ code: 'E_SCHEMA', pointer: '/tracks/keys/velocityInput' }));
});

it('validates the realized patch without applying its runtime range for a second time', () => {
  const instrument = { ...PAD, layers: [{ ...PAD.layers[0], amp: { attack: .01, decay: .1, sustain: .7, release: 3 } }], xRuntime: {
    inputs: { touch: { min: 0, max: 1, default: 0 } },
    bind: [{ input: 'touch', target: '/layers/0/amp/release', range: [0, 1] }],
  } };
  expect(() => resolveInstruments(project(), score(instrument))).not.toThrow(); // 6 s, not 12 s
});
