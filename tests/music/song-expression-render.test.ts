import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import type { Patch } from '../../src/schema/patch.ts';
import type { Song, SongPattern } from '../../src/schema/song.ts';
import { patch } from '../helpers/patches.ts';
import { song } from '../helpers/songs.ts';

interface Pcm { sampleRate: number; channels: Float32Array[] }

const sine = patch({ schema: 'beeps/patch@1', name: 'sine', family: 'music', duration: 1,
  layers: [{ source: { type: 'osc', wave: 'sine', pitch: 'A3' },
    amp: { attack: .005, decay: 0, sustain: 1, release: .2 } }] });
const saw = patch({ schema: 'beeps/patch@1', name: 'saw', family: 'music', duration: 1,
  layers: [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'A3' },
    amp: { attack: .005, decay: 0, sustain: 1, release: .2 },
    filter: { type: 'lowpass', cutoff: 440, resonanceDb: 0 } }] });

function phrase(notes: SongPattern['notes']): Song {
  return song({ tracks: { keys: { instrument: 'keys' } },
    patterns: { phrase: { bars: 1, gate: 1, notes } },
    sections: { a: { bars: 1, play: { keys: 'phrase' } } }, form: ['a'] });
}

// A Hann-windowed Fourier bin measures the sound, rather than inspecting scheduled AudioParams.
function amplitude(pcm: Pcm, hz: number, start: number, end: number): number {
  const ch = pcm.channels[0], from = Math.round(start * pcm.sampleRate), n = Math.round((end - start) * pcm.sampleRate);
  let re = 0, im = 0, weight = 0;
  for (let i = 0; i < n; i++) {
    const w = .5 - .5 * Math.cos(2 * Math.PI * i / (n - 1));
    const phase = 2 * Math.PI * hz * i / pcm.sampleRate;
    re += ch[from + i] * w * Math.cos(phase); im += ch[from + i] * w * Math.sin(phase); weight += w;
  }
  return 2 * Math.hypot(re, im) / weight;
}

function peak(pcm: Pcm, start: number, end: number): number {
  return pcm.channels[0].subarray(Math.round(start * pcm.sampleRate), Math.round(end * pcm.sampleRate))
    .reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

const sha = (pcm: Pcm) => pcm.channels.map(ch => createHash('sha256')
  .update(Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength)).digest('hex'));

function sumError(mix: Pcm, stems: Pcm[]): number {
  let error = 0;
  for (const stem of stems) expect(stem.channels[0].length).toBe(mix.channels[0].length);
  for (let ch = 0; ch < mix.channels.length; ch++) for (let i = 0; i < mix.channels[ch].length; i++) {
    error = Math.max(error, Math.abs(mix.channels[ch][i] - stems.reduce((sum, stem) => sum + stem.channels[ch][i], 0)));
  }
  return error;
}

const touch = patch({ schema: 'beeps/patch@1', name: 'touch', family: 'music', duration: .5,
  layers: [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'A3' },
    amp: { attack: .04, decay: .1, sustain: .8, release: .3 },
    filter: { type: 'lowpass', cutoff: 800, resonanceDb: 0, env: { to: 1600, time: .15 } },
    lfo: { target: 'pitch', rate: 4, depth: 5 } }],
  xRuntime: { inputs: { touch: { min: 10, max: 20, default: 15 } }, bind: [
    { input: 'touch', target: '/layers/0/filter/cutoff', range: [-1, 1], live: true },
    { input: 'touch', target: '/layers/0/amp/attack', range: [1, -1] },
    { input: 'touch', target: '/layers/0/amp/release', range: [-1, 1] },
    { input: 'touch', target: '/out/gainDb', range: [-3, 2] },
  ] } });
const performance = song({ seed: 73, tracks: {
  lead: { instrument: 'touch', velocityInput: 'touch', gainDb: -10, pan: -.3, humanize: .4, sends: { delay: -12, reverb: -15 } },
  bass: { instrument: 'touch', velocityInput: 'touch', gainDb: -12, pan: .25, humanize: .3, sends: { delay: -18, reverb: -20 } },
}, patterns: {
  lead: { bars: 2, gate: .8, notes: [
    { at: 0, note: 'A3', beats: 2, vel: .3, expression: { pitch: [[0, -3], [.5, 0], [2, 2]], brightness: [[0, -1], [1, 1, 'step']] } },
    { at: 1, note: 'E4', beats: 2, vel: .8, expression: { pitch: [[0, 2], [1, 0]], brightness: [[0, 1], [2, -1]] } },
    { at: 4.1, note: 'C4', beats: 2.7, vel: .65, expression: { pitch: [[0, -1], [2, 1]], brightness: [[0, -.5], [2.7, .5]] } },
  ] },
  bass: { bars: 2, gate: 1, notes: [
    { at: .2, note: 'A2', beats: 3.5, vel: .7, expression: { pitch: [[0, 0], [1, -2, 'step']], brightness: [[0, .5], [3, -1]] } },
    { at: 5, note: 'E3', beats: 2, vel: .35, expression: { pitch: [[0, -2], [.5, 0]], brightness: [[0, -1], [2, 1]] } },
  ] },
}, master: { reverb: { preset: 'room', returnDb: -12 }, delay: { beats: .5, feedback: .2, cutoff: 2500, returnDb: -15 } },
sections: { a: { bars: 2, play: { lead: 'lead', bass: 'bass' } } }, form: ['a'] });
const performanceInstruments = { lead: touch, bass: touch };

describe.skipIf(!(await chromiumAvailable()))('expressive song audio in Chromium', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  async function render(s: Song, instruments: Record<string, Patch>, only?: string[]): Promise<Pcm> {
    const r = await host.renderSong(s, instruments, only ? { only } : {});
    try { return { sampleRate: r.sampleRate, channels: await host.pullSong(r.id, r.frames) }; }
    finally { await host.freeSong(r.id); }
  }

  async function graph(windowSeconds: number | null): Promise<Pcm> {
    const raw = await host.page.evaluate(async ({ s, instruments, windowSeconds }) => {
      const { buildSong, songTail } = await new Function("return import('/engine/song.js')")();
      const { compileSong } = await new Function("return import('/engine/sequence.js')")();
      const { toBase64 } = await new Function("return import('/engine/offline.js')")();
      const sampleRate = 48000, { length } = compileSong(s);
      const ctx = new OfflineAudioContext(2, Math.ceil((length + songTail(s, instruments)) * sampleRate), sampleRate);
      const built = buildSong(ctx, s, instruments, { lazy: windowSeconds !== null, retain: true });
      if (windowSeconds !== null) {
        built.advance(windowSeconds + .05);
        const quantum = 128 / sampleRate;
        for (let t = windowSeconds; t < length; t += windowSeconds) {
          const at = Math.round(t / quantum) * quantum;
          ctx.suspend(at).then(() => { built.release(at); built.advance(at + windowSeconds + .05); ctx.resume(); });
        }
      }
      const buffer = await ctx.startRendering();
      return { sampleRate, channels: [toBase64(buffer.getChannelData(0)), toBase64(buffer.getChannelData(1))] as string[] };
    }, { s: performance, instruments: performanceInstruments, windowSeconds });
    return { sampleRate: raw.sampleRate, channels: raw.channels.map(encoded => {
      const b = Buffer.from(encoded, 'base64');
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    }) };
  }

  it('plays semitone pitch steps at beat time while overlapping notes keep their own pitch', async () => {
    const notes: NonNullable<SongPattern['notes']> = [
      { at: 0, note: 'A3', beats: 3, vel: .35, expression: { pitch: [[0, -12], [1, 12, 'step']] } },
      [.5, 'A3', 2.5, .25],
    ];
    const mix = await render(phrase(notes), { keys: sine });
    expect(amplitude(mix, 110, .1, .2)).toBeGreaterThan(.3);
    expect(amplitude(mix, 220, .1, .2)).toBeLessThan(.001);
    expect(amplitude(mix, 110, .38, .48)).toBeGreaterThan(.3); // step arrives at one beat = .5 s
    expect(amplitude(mix, 440, .6, .7)).toBeGreaterThan(.3);
    expect(amplitude(mix, 220, .6, .7)).toBeGreaterThan(.2); // overlapping unexpressed voice
    const solo = [];
    for (const note of notes) solo.push(await render(phrase([note]), { keys: sine }));
    expect(sumError(mix, solo)).toBeLessThan(1e-6);
  });

  it('moves a saw filter by octaves without changing an overlapping voice sharing its instrument', async () => {
    const notes: NonNullable<SongPattern['notes']> = [
      { at: 0, note: 'A3', beats: 3, vel: .35, expression: { brightness: [[0, -1], [1, 2, 'step']] } },
      [.5, 'E4', 2.5, .25],
    ];
    const expressive = await render(phrase([notes[0]]), { keys: saw });
    const dark = amplitude(expressive, 1100, .1, .2) / amplitude(expressive, 220, .1, .2);
    const bright = amplitude(expressive, 1100, .6, .7) / amplitude(expressive, 220, .6, .7);
    expect(bright).toBeGreaterThan(dark * 12);
    expect(bright).toBeGreaterThan(.15);
    const untouched = await render(phrase([notes[1]]), { keys: saw });
    const mix = await render(phrase(notes), { keys: saw });
    expect(sumError(mix, [expressive, untouched])).toBeLessThan(1e-6);
  });

  it('renders both curves and velocity response bit-identically on repeats and across eager/lazy batch sizes', async () => {
    const reference = await render(performance, performanceInstruments);
    expect(peak(reference, 0, 4)).toBeGreaterThan(.01);
    expect(sha(await render(performance, performanceInstruments))).toEqual(sha(reference));
    for (const windowSeconds of [null, .125, .7]) expect(sha(await graph(windowSeconds)), `advance batch ${windowSeconds}`).toEqual(sha(reference));
  });

  it('sums expressive, velocity-responsive stems back to the full mix including shared effect returns', async () => {
    const mix = await render(performance, performanceInstruments);
    const lead = await render(performance, performanceInstruments, ['lead']);
    const bass = await render(performance, performanceInstruments, ['bass']);
    expect(peak(lead, 0, 4)).toBeGreaterThan(.01);
    expect(peak(bass, 0, 4)).toBeGreaterThan(.01);
    expect(sumError(mix, [lead, bass])).toBeLessThan(1e-6);
  });

  it('preserves a velocity-mapped hard-right layer pan through the track bus', async () => {
    const instrument = patch({ ...sine, name: 'touch-pan', layers: [{ ...sine.layers[0], pan: 0 }],
      xRuntime: { inputs: { touch: { min: 0, max: 1, default: 0 } },
        bind: [{ input: 'touch', target: '/layers/0/pan', range: [0, 1] }] } });
    const s = phrase([[0, 'A3', 2, 1]]);
    s.tracks.keys.velocityInput = 'touch';
    const pcm = await render(s, { keys: instrument });
    const peaks = pcm.channels.map(ch => ch.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0));
    expect(peaks[1]).toBeGreaterThan(.9);
    expect(peaks[0]).toBeLessThan(1e-6);
  });

  it('allocates the full velocity-shaped release after a late note and renders its end to silence', async () => {
    const longRelease = patch({ ...sine, name: 'long-release', duration: .05,
      layers: [{ ...sine.layers[0], amp: { attack: .005, decay: 0, sustain: 1, release: .2 } }],
      xRuntime: { inputs: { touch: { min: 0, max: 1, default: 0 } },
        bind: [{ input: 'touch', target: '/layers/0/amp/release', range: [0, 3] }] } });
    const s = phrase([{ at: 3.5, note: 'A3', beats: .5, vel: 1, expression: { pitch: [[0, 12]] } }]);
    s.tracks.keys.velocityInput = 'touch';
    const pcm = await render(s, { keys: longRelease });
    expect(pcm.channels[0].length / pcm.sampleRate).toBeGreaterThanOrEqual(3.6); // note-off 2 s + 1.6 s release
    expect(peak(pcm, 2.8, 2.9)).toBeGreaterThan(.3);
    expect(amplitude(pcm, 440, 2.8, 2.9)).toBeGreaterThan(.3); // expression holds through release
    const end = pcm.channels[0].length / pcm.sampleRate;
    expect(peak(pcm, end - .05, end)).toBeLessThan(1e-7);
  });
});
