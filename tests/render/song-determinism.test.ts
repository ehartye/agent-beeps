// A song renders bit-exactly, run after run and in a fresh browser. Songs are built lazily while the offline context is suspended
// every 2 s (runtime/engine/offline.js), so the page allocates nodes while it renders and the garbage collector runs mid-render.
// Chromium disposes a node whose wrapper is collected and drops its output connections on the spot, and two things then depended on
// when the collection ran: a source that has finished (a modal drum's 5 ms exciter) took the still-ringing resonators behind it with
// it, and a filter on a track bus whose input channel count flipped between mono and stereo (a spread chord's centre note is mono,
// the others are panned) lost its state. A real render hits those at random; here a collection is forced every 40 ms, so a graph that
// is exposed to either shows within a few renders.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAvailable, openRenderHost, verifyingDeterminism, type RenderHost } from '../../src/render/host.ts';
import { patch } from '../helpers/patches.ts';
import { song } from '../helpers/songs.ts';

const RUNS = Number(process.env.RUNS ?? 4);
const SUSTAINED = {
  schema: 'beeps/patch@1', name: 'sustained', family: 'music', duration: 2,
  layers: [
    { source: { type: 'osc', wave: 'triangle', pitch: 'C4', unison: { voices: 3, detuneCents: 12 } }, amp: { attack: 0.5, decay: 1, sustain: 0.8, release: 2.5 }, filter: { type: 'lowpass', cutoff: 1200, resonanceDb: 0 } },
    { source: { type: 'osc', wave: 'sine', pitch: 'C4' }, gainDb: -9, amp: { attack: 0.6, decay: 1, sustain: 0.8, release: 2.5 } },
  ],
};
const DRUM = {
  schema: 'beeps/patch@1', name: 'drum', family: 'music', duration: 0.3,
  layers: [{ source: { type: 'modal', pitch: 'G3', modes: [[1, 40, 0], [1.59, 30, -4], [2.14, 26, -8], [2.65, 18, -14]], exciter: 'noiseBurst' }, amp: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.1 } }],
};
const BRASS = {
  schema: 'beeps/patch@1', name: 'brass', family: 'music', duration: 2,
  layers: [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'C4', unison: { voices: 3, detuneCents: 10 } }, amp: { attack: 0.12, decay: 0.6, sustain: 0.8, release: 0.4 }, filter: { type: 'lowpass', cutoff: 500, resonanceDb: 3, env: { to: 2600, time: 0.35 } } }],
};
const SONG = song({
  bpm: 112, loop: false, master: { reverb: { preset: 'room', returnDb: -6 }, delay: { beats: 0.75, feedback: 0.25, cutoff: 1800, returnDb: -16 } },
  progressions: { a: [['C', 4], ['F', 4], ['G', 4], ['Am', 4]] },
  tracks: {
    pad: { instrument: SUSTAINED, cutoff: 1400, sends: { reverb: -6 }, spread: 0.6 },
    drum: { instrument: DRUM, pan: -0.1, cutoff: 1400 },
    // No track sends into the master delay, so nothing upstream holds it: the page keeps no reference to its feedback loop either,
    // and a collection disposed of the loop (and its connection into the mix) at a moment that changed from run to run.
    brass: { instrument: BRASS, cutoff: 900, sends: { reverb: -5 } },
  },
  patterns: {
    'pad-a': { bars: 4, chords: { progression: 'a', octave: 3, voicing: 'open' } },
    'drum-a': { bars: 4, steps: 'x...x.x.x...x.xx' },
    'brass-a': { bars: 4, notes: [[0, 'D3', 8], [0, 'A3', 8]] },
  },
  sections: { a: { bars: 4, play: { pad: 'pad-a', drum: 'drum-a', brass: 'brass-a' } } },
});
const INSTRUMENTS = { pad: patch(SUSTAINED), drum: patch(DRUM), brass: patch(BRASS) };

const sha = (chs: Float32Array[]) => chs.map(c => createHash('sha256').update(Buffer.from(c.buffer, c.byteOffset, c.byteLength)).digest('hex').slice(0, 12)).join('/');
async function render(host: RenderHost, { collect = 0 } = {}) {
  const cdp = collect ? await host.page.context().newCDPSession(host.page) : undefined;
  const timer = cdp && setInterval(() => { cdp.send('HeapProfiler.collectGarbage').catch(() => {}); }, collect);
  try {
    const r = await host.renderSong(SONG, INSTRUMENTS);
    const chs = await host.pullSong(r.id, r.frames);
    await host.freeSong(r.id);
    return chs;
  } finally { clearInterval(timer); await cdp?.detach().catch(() => {}); }
}

describe.skipIf(!(await chromiumAvailable()))('song render determinism', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it(`renders a song bit-identically ${RUNS} times with a garbage collection forced every 40 ms, as it does with none`, async () => {
    const reference = await render(host);
    expect(reference[0].some(x => Math.abs(x) > 0.01)).toBe(true);
    const want = sha(reference);
    const got: string[] = [];
    for (let n = 0; n < RUNS; n++) got.push(sha(await render(host, { collect: 40 })));
    expect(got, 'forced collections changed the render').toEqual(Array(RUNS).fill(want));
  }, 120000);

  it('passes its own check: the verifying host renders twice, compares in the page and hands back a render that matches', async () => {
    const want = sha(await render(host));
    const checked = verifyingDeterminism(host);
    const r = await checked.renderSong(SONG, INSTRUMENTS);
    expect(sha(await host.pullSong(r.id, r.frames))).toBe(want);
    await host.freeSong(r.id);
  }, 120000);

  it('renders it identically in a fresh browser', async () => {
    const first = sha(await render(host));
    const other = await openRenderHost();
    try { expect(sha(await render(other, { collect: 40 }))).toBe(first); } finally { await other.close(); }
  }, 120000);
});
