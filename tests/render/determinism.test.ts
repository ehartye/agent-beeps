// Renders must be bit-exact for a seed. Chromium sums the connections into one node input (or AudioParam) in an order
// that changes from run to run, and float addition of three or more terms rounds differently in a different order
// (two terms commute exactly). These patches each put three or more signals into one sum somewhere.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAvailable, openRenderHost, type RenderHost, type RenderResult } from '../../src/render/host.ts';
import type { Patch } from '../../src/schema/patch.ts';
import { patch } from '../helpers/patches.ts';
import { HAT, PAD, song } from '../helpers/songs.ts';

const RUNS = 8;
const amp = { attack: 0.004, decay: 0.3, sustain: 0, release: 0.1 };
const sfx = (name: string, layers: unknown[], extra: Record<string, unknown> = {}): Patch =>
  patch({ schema: 'beeps/patch@1', name, family: 'explosion', duration: 0.45, layers, ...extra });

const CASES: Patch[] = [
  // Three layers into the patch mix: the Sector Run explosions' shape.
  sfx('three-noise-layers', [
    { source: { type: 'noise', color: 'white' }, amp },
    { source: { type: 'noise', color: 'brown' }, amp, filter: { type: 'bandpass', cutoff: 900, q: 0.35, env: { to: 160, time: 0.35 } } },
    { source: { type: 'noise', color: 'pink' }, amp, filter: { type: 'highpass', cutoff: 1500, resonanceDb: 0 } },
  ]),
  sfx('four-osc-layers', ['sine', 'sawtooth', 'triangle', 'square'].map((wave, i) => ({ source: { type: 'osc', wave, pitch: ['G2', 'C4', 'E5', 'A3'][i] }, amp }))),
  // Six squares into one sum, then two bands into the source output.
  sfx('metal', [{ source: { type: 'metal', base: 300, bands: [3000, 6000] }, amp }]),
  sfx('unison', [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'C4', unison: { voices: 5, detuneCents: 20 } }, amp }]),
  sfx('additive', [{ source: { type: 'additive', pitch: 'C5', partials: [[1, 0, 0.3], [2.76, -6, 0.2], [5.4, -10, 0.1], [8.9, -14, 0.05]] }, amp }]),
  sfx('modal', [{ source: { type: 'modal', pitch: 'C4', modes: [[1, 40, 0], [2.3, 50, -6], [3.9, 60, -9]], exciter: 'noiseBurst' }, amp }]),
  // Three operators modulate operator 0's frequency.
  sfx('fm', [{ source: { type: 'fm', pitch: 'C3', operators: [{ ratio: 1 }, { ratio: 2, index: 2 }, { ratio: 3.5, index: 1.5 }, { ratio: 7, index: 1 }], algorithm: [[1, 0], [2, 0], [3, 0]] }, amp }]),
  // Dry, reverb and delay into the authored sum.
  sfx('fx', [{ source: { type: 'noise', color: 'white' }, amp }, { source: { type: 'osc', wave: 'sine', pitch: 'G2' }, amp }],
    { fx: { reverb: { preset: 'room', sendDb: -6 }, delay: { time: 0.12, feedback: 0.4, sendDb: -8 } } }),
];

const bits = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const ok = (r: RenderResult) => { if (!r.ok) throw new Error(r.error); return r; };
/** How many samples differ in bits from the first run, per later run. */
const diffs = (runs: Float32Array[][]) => runs.slice(1).map(chs => chs.reduce((n, ch, c) => {
  const a = new Uint32Array(runs[0][c].buffer, runs[0][c].byteOffset, runs[0][c].length);
  const b = new Uint32Array(ch.buffer, ch.byteOffset, ch.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return n + d;
}, 0));

describe.skipIf(!(await chromiumAvailable()))('render determinism', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it.each(CASES.map(p => [p.name, p] as const))('renders %s bit-exactly for a seed', async (_name, p) => {
    const runs = (await host.render(Array.from({ length: RUNS }, () => ({ patch: p, opts: { seed: 1, trimDb: -3 } })))).map(ok);
    expect(runs[0].authored[0].some(x => x !== 0)).toBe(true);
    expect(diffs(runs.map(r => r.authored))).toEqual(Array(RUNS - 1).fill(0));
    expect(diffs(runs.map(r => r.delivered))).toEqual(Array(RUNS - 1).fill(0));
    expect(bits(runs[RUNS - 1].delivered[1]).equals(bits(runs[0].delivered[1]))).toBe(true);
  });

  it('renders a song with overlapping notes, several tracks and both master effects bit-exactly', async () => {
    const s = song({
      master: { reverb: { preset: 'room', returnDb: -8 }, delay: { beats: 0.75, returnDb: -10 } },
      tracks: {
        pad: { instrument: PAD, sends: { reverb: -6, delay: -8 } },
        hat: { instrument: HAT, gainDb: -6, sends: { reverb: -10 } },
        lead: { instrument: PAD, gainDb: -4, sends: { delay: -6 } },
      },
      patterns: {
        'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 } },
        'hat-a': { bars: 1, steps: 'x.x.x.x.x.x.x.x.' },
        'lead-a': { bars: 2, chords: { progression: 'a', octave: 5 } },
      },
      sections: { a: { bars: 2, play: { pad: 'pad-a', hat: 'hat-a', lead: 'lead-a' } } },
    });
    const instruments = { pad: patch(PAD), hat: patch(HAT), lead: patch(PAD) };
    const runs: Float32Array[][] = [];
    for (let n = 0; n < 4; n++) {
      const r = await host.renderSong(s, instruments);
      runs.push(await host.pullSong(r.id, r.frames));
      await host.freeSong(r.id);
    }
    expect(runs[0][0].some(x => x !== 0)).toBe(true);
    expect(diffs(runs)).toEqual([0, 0, 0]);
  });
});
