import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSong } from '../../runtime/engine/song.js';
import { prepareSampleWavs } from '../../runtime/engine/samples.js';
import { writeWav } from '../../src/audio/wav.ts';
import { initProject } from '../../src/project.ts';
import { resolveInstruments } from '../../src/music.ts';
import { samplePaths, writeSampleObject } from '../../src/samples/store.ts';
import { renderSong } from '../../src/render/song-pipeline.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import { resolveSamplesForPatches } from '../../src/samples/transport.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch } from '../helpers/patches.ts';
import { PAD, song } from '../helpers/songs.ts';

const dir = mkdtempSync(join(tmpdir(), 'beeps-song-samples-'));
const project = initProject(dir), objects = samplePaths(project).objects;
const data = Float32Array.from({ length: 24000 }, (_, i) => .3 * Math.sin(i * Math.PI / 100));
const wav = writeWav([data, Float32Array.from(data, x => -x / 2)], 48000, { bits: 32 });
const source = writeSampleObject(objects, wav);
const recording = patch({ schema: 'beeps/patch@1', name: 'recording', family: 'music', duration: .7,
  layers: [{ source: { type: 'sample', asset: source.id }, amp: { attack: .001, decay: 0, sustain: 1, release: .05 } }] });
const interiorGain = patch({ ...recording, xRuntime: {
  inputs: { touch: { min: 0, max: 1, default: 0 } }, bind: [
    { input: 'touch', target: '/layers/0/gainDb', range: [0, 2000], shape: 'sqrt' },
    { input: 'touch', target: '/layers/0/gainDb', range: [0, -2000], shape: 'quad' },
  ],
} });
const interiorFm = patch({ ...recording, layers: [...recording.layers, {
  source: { type: 'fm', pitch: 440, operators: [{ ratio: 1, index: 1 }, { ratio: 1, index: 1 }], algorithm: [[1, 0]] },
  amp: { attack: .001, decay: 0, sustain: 1, release: .05 },
}], xRuntime: {
  inputs: { touch: { min: 0, max: 1, default: 0 } }, bind: [
    { input: 'touch', target: ['/layers/1/source/pitch', '/layers/1/source/operators/0/ratio'], range: [0, 140], shape: 'sqrt', unit: 'oct' },
    { input: 'touch', target: ['/layers/1/source/pitch', '/layers/1/source/operators/0/ratio'], range: [0, -140], shape: 'quad', unit: 'oct' },
  ],
} });
const negativeInterior = (instrument: object, target: string) => patch({ ...instrument, xRuntime: {
  inputs: { touch: { min: 0, max: 1, default: 0 } }, bind: [
    { input: 'touch', target, range: [0, -2], shape: 'sqrt', unit: 'lin' },
    { input: 'touch', target, range: [0, 2], shape: 'quad', unit: 'lin' },
  ],
} });
const interiorRelease = negativeInterior({ ...recording, layers: [{ ...recording.layers[0], amp: {
  ...recording.layers[0].amp, release: .01,
} }] }, '/layers/0/amp/release');
const score = (track: object = {}, pattern: object = { bars: 1, notes: [[0, 'C2', .25], [1, 'C6', .25]], gate: 'patch' }) => song({
  tracks: { recorded: { instrument: recording, fixed: true, ...track } }, patterns: { line: pattern },
  sections: { a: { bars: 1, play: { recorded: 'line' } } }, form: ['a'],
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('finite song sample contract', () => {
  it('builds fresh one-shot sources per fixed note and releases retained notes', () => {
    const f = new FakeContext(), ctx = asCtx(f);
    const samples = prepareSampleWavs(ctx, recording, { [source.id]: wav });
    const built = buildSong(ctx, score(), { recorded: recording }, { samples, retain: true });
    const voices = f.nodes('bufferSource');
    expect(voices).toHaveLength(2);
    expect(voices[0]).not.toBe(voices[1]);
    expect(voices.map(v => v.buffer)).toEqual([samples[source.id], samples[source.id]]);
    expect(voices.map(v => v.startedAt)).toEqual([0, .5]);
    expect(voices.map(v => v.stoppedAt)).toEqual([.76, 1.26]);
    expect(voices.every(v => v.loop === false && v.playbackRate.value === 1)).toBe(true);
    expect(built.done()).toBe(true);
    expect(built.release(5)).toBe(2);
  });

  it.each([
    [{ fixed: false }, 'fixed'], [{ transpose: 1 }, 'transpose'], [{ root: 'C4' }, 'root'],
  ])('rejects requested sample retuning %j before graph allocation', (over, field) => {
    const s = score(over), f = new FakeContext();
    expect(() => resolveInstruments(project, s)).toThrow(expect.objectContaining({ pointer: `/tracks/recorded/${field}` }));
    expect(() => buildSong(asCtx(f), s, { recorded: recording })).toThrow(new RegExp(field));
    expect(f.created).toEqual([]);
  });

  it('rejects pitch expression even on a hybrid instrument and preflights silent tracks', () => {
    const hybrid = patch({ ...recording, layers: [...recording.layers, ...patch(PAD).layers] });
    const s = score({}, { bars: 1, notes: [{ at: 0, note: 'C4', beats: 1, expression: { pitch: [[0, 1]] } }] });
    const f = new FakeContext();
    expect(() => buildSong(asCtx(f), s, { recorded: hybrid })).toThrow(/sample.*pitch|pitch.*sample/i);
    expect(f.created).toEqual([]);
    expect(() => buildSong(asCtx(f), score(), { recorded: recording }, { only: ['absent'] })).toThrow(/missing prepared sample/);
    expect(f.created).toEqual([]);
  });

  it('preflights later performed velocity mappings before starting earlier notes', () => {
    const s = score({ velocityInput: 'touch' }, { bars: 1, notes: [[0, 'C4', .25, 0], [1, 'C4', .25, 1]] });
    // Parsed instruments are the engine contract; this adversarial realized value overflows
    // only at the second note, after the first note would otherwise have started.
    const p = structuredClone(recording);
    p.xRuntime = { delivery: 'baked', inputs: { touch: { min: 0, max: 1, default: 0 } }, bind: [
      { input: 'touch', target: '/layers/0/amp/release', range: [0, 2000] },
    ] };
    const f = new FakeContext(), samples = prepareSampleWavs(asCtx(f), p, { [source.id]: wav });
    expect(() => buildSong(asCtx(f), s, { recorded: p }, { samples })).toThrow(/recorded.*velocityInput.*finite/i);
    expect(f.created).toEqual([]);
  });

  it.each([['linear layer gain', interiorGain], ['FM frequency product', interiorFm]] as const)(
    'rejects an overflowing derived %s at an interior velocity before allocating any nodes', (_name, p) => {
      const s = score({ velocityInput: 'touch' }, { bars: 1, notes: [[0, 'C4', .25, 0], [1, 'C4', .25, .5]] });
      const f = new FakeContext(), samples = prepareSampleWavs(asCtx(f), p, { [source.id]: wav });
      expect(() => buildSong(asCtx(f), s, { recorded: p }, { samples })).toThrow(/recorded.*velocityInput.*finite.*velocity 0.5/);
      expect(f.created).toEqual([]);
    });

  it.each([
    ['release schedule', interiorRelease],
    ['filter envelope time', negativeInterior({ ...recording, layers: [{ ...recording.layers[0],
      filter: { type: 'lowpass', cutoff: 1000, env: { to: 500, time: .01 } },
    }] }, '/layers/0/filter/env/time')],
    ['additive time constant', negativeInterior({ ...recording, layers: [...recording.layers, {
      source: { type: 'additive', pitch: 440, partials: [[1, -6, .01]] }, amp: recording.layers[0].amp,
    }] }, '/layers/1/source/partials/0/2')],
    ['grain rate', negativeInterior({ ...recording, layers: [...recording.layers, {
      source: { type: 'grains', rate: .01, grainDecay: .01, center: 1000 }, amp: recording.layers[0].amp,
    }] }, '/layers/1/source/rate')],
  ])('rejects a negative performed %s before allocating nodes', (_name, p) => {
    const s = score({ velocityInput: 'touch' }, { bars: 1, notes: [[0, 'C4', .25, 0], [1, 'C4', .25, .5]] });
    const f = new FakeContext(), samples = prepareSampleWavs(asCtx(f), p, { [source.id]: wav });
    expect(() => buildSong(asCtx(f), s, { recorded: p }, { samples })).toThrow(/recorded.*velocityInput.*(nonnegative|positive).*velocity 0.5/);
    expect(f.created).toEqual([]);
  });

  it('preserves zero amp times and musical held durations beyond the patch schema limit', () => {
    const p = patch({ ...recording, layers: [{ ...recording.layers[0], amp: { attack: 0, decay: 0, sustain: 1, release: 0 } }],
      xRuntime: { inputs: { touch: { min: 0, max: 1, default: 0 } }, bind: [
        { input: 'touch', target: '/layers/0/gainDb', range: [0, 1] },
      ] } });
    const s = song({ ...score({ velocityInput: 'touch' }), bpm: 30,
      patterns: { line: { bars: 8, gate: 1, notes: [[0, 'C4', 24, .5]] } },
      sections: { a: { bars: 8, play: { recorded: 'line' } } },
    });
    const f = new FakeContext(), samples = prepareSampleWavs(asCtx(f), p, { [source.id]: wav });
    expect(() => buildSong(asCtx(f), s, { recorded: p }, { samples })).not.toThrow();
    expect(f.nodes('bufferSource').map(n => n.stoppedAt)).toEqual([48.01]);
  });

  it('preflights a mapped grain source length before attempting an impossible native buffer', () => {
    const p = patch({ ...recording, layers: [{ ...recording.layers[0], source: { type: 'grains', rate: 10, grainDecay: .01, center: 1000 },
      amp: { ...recording.layers[0].amp, release: .01 } }], xRuntime: {
      inputs: { touch: { min: 0, max: 1, default: 0 } }, bind: [
        { input: 'touch', target: '/layers/0/amp/release', range: [0, 200], shape: 'sqrt' },
        { input: 'touch', target: '/layers/0/amp/release', range: [0, -200], shape: 'quad' },
      ],
    } });
    const s = score({ velocityInput: 'touch' }, { bars: 1, notes: [[0, 'C4', .25, 0], [1, 'C4', .25, .5]] });
    const f = new FakeContext();
    expect(() => buildSong(asCtx(f), s, { recorded: p })).toThrow(/recorded.*velocityInput.*source duration.*velocity 0.5/);
    expect(f.created).toEqual([]);
  });
});

describe.skipIf(!(await chromiumAvailable()))('sample songs through the production Chromium host', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });
  async function pcm(s = score(), instruments = { recorded: recording }, only?: string[]) {
    const r = await host.renderSong(s, instruments, { sampleWavs: resolveSamplesForPatches(Object.values(instruments), objects), only });
    try { return await host.pullSong(r.id, r.frames); } finally { await host.freeSong(r.id); }
  }
  const peak = (ch: Float32Array, from: number, to: number) => ch.subarray(Math.round(from * 48000), Math.round(to * 48000)).reduce((p, x) => Math.max(p, Math.abs(x)), 0);

  it.each([['derived gain overflow', interiorGain, /finite/], ['negative release', interiorRelease, /nonnegative/]] as const)(
    'rejects %s in Chromium before allocating or starting song nodes', async (_name, p, domain) => {
    const s = score({ velocityInput: 'touch' }, { bars: 1, notes: [[0, 'C4', .25, 0], [1, 'C4', .25, .5]] });
    const result = await host.page.evaluate(async ({ s, p, encoded }) => {
      const { buildSong } = await new Function("return import('/engine/song.js')")();
      const { prepareEncodedSamples } = await new Function("return import('/engine/offline.js')")();
      const ctx = new OfflineAudioContext(2, 96000, 48000);
      const samples = prepareEncodedSamples(ctx, p, encoded);
      let allocated = 0;
      const starts: number[] = [];
      const gain = ctx.createGain.bind(ctx), source = ctx.createBufferSource.bind(ctx);
      ctx.createGain = () => { allocated++; return gain(); };
      ctx.createBufferSource = () => {
        allocated++; const n = source(), start = n.start.bind(n);
        n.start = (at = 0) => { starts.push(at); start(at); }; return n;
      };
      let error = '';
      try { buildSong(ctx, s, { recorded: p }, { samples }); } catch (e) { error = String(e); }
      return { allocated, starts, error };
    }, { s, p, encoded: resolveSamplesForPatches([p], objects) });
    expect(result.error).toMatch(/recorded.*velocityInput.*velocity 0.5/);
    expect(result.error).toMatch(domain);
    expect(result.allocated).toBe(0);
    expect(result.starts).toEqual([]);
  });

  it('preserves exact stereo sample PCM, fixed pitch, finite end and repeated determinism', async () => {
    const a = await pcm(), b = await pcm();
    expect(a).toEqual(b);
    expect(a[0].slice(4800, 9600)).toEqual(data.slice(4800, 9600));
    expect(a[1].slice(4800, 9600)).toEqual(Float32Array.from(data.slice(4800, 9600), x => -x / 2));
    expect(a[0].slice(4800, 9600)).toEqual(a[0].slice(28800, 33600));
    expect(peak(a[0], 1.01, 1.2)).toBe(0);
    const other = writeSampleObject(objects, writeWav([Float32Array.from(data, x => -x)], 48000, { bits: 32 }));
    const changed = patch({ ...recording, layers: [{ ...recording.layers[0], source: { type: 'sample', asset: other.id } }] });
    expect((await pcm(score(), { recorded: changed }))[0]).not.toEqual(a[0]);
  });

  it('matches a hybrid patch authored PCM through the song mixer', async () => {
    const hybrid = patch({ ...recording, layers: [...recording.layers, ...patch(PAD).layers] });
    const s = score({}, { bars: 1, notes: [[0, 'C7', .25]], gate: 'patch' });
    const actual = await pcm(s, { recorded: hybrid });
    const [rendered] = await host.render([{ patch: hybrid, opts: { seed: s.seed * 101,
      sampleWavs: resolveSamplesForPatches([hybrid], objects) } }]);
    if (!rendered.ok) throw new Error(rendered.error);
    for (let c = 0; c < 2; c++) expect(actual[c].slice(0, rendered.authored[c].length)).toEqual(rendered.authored[c]);
  });

  it('honors held gates and patch tails, folds loops and sums hybrid solos', async () => {
    const held = await pcm(score({}, { bars: 1, notes: [[0, 'C4', .2]], gate: 1 }));
    expect(peak(held[0], .02, .08)).toBeGreaterThan(.2);
    expect(peak(held[0], .16, .3)).toBe(0);
    const tailScore = score({}, { bars: 1, notes: [[3.8, 'C4', .2]], gate: 'patch' });
    const tail = await pcm(tailScore), looped = await pcm({ ...tailScore, loop: true });
    expect(peak(tail[0], 2.05, 2.2)).toBeGreaterThan(.2);
    expect(looped[0].length).toBe(96000);
    expect(looped[0].slice(0, 9600)).toEqual(tail[0].slice(96000, 105600));
    const s = song({ ...score(), tracks: { recorded: { instrument: recording, fixed: true }, synth: { instrument: PAD } },
      sections: { a: { bars: 1, play: { recorded: 'line', synth: 'line' } } } });
    const instruments = { recorded: recording, synth: patch(PAD) };
    const mix = await pcm(s, instruments), rec = await pcm(s, instruments, ['recorded']), synth = await pcm(s, instruments, ['synth']);
    let max = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < mix[c].length; i++) max = Math.max(max, Math.abs(mix[c][i] - rec[c][i] - synth[c][i]));
    expect(max).toBeLessThan(1e-6);
  });

  it('verifies real source bytes before warm song cache reuse', async () => {
    const opts = { project: project.project, rendersDir: project.paths.renders, sampleObjectsDir: objects };
    const first = await renderSong(host, score(), { recorded: recording }, opts);
    expect((await renderSong(host, score(), { recorded: recording }, opts)).cached).toBe(true);
    expect(readFileSync(first.wavPath).length).toBeGreaterThan(44);
    writeFileSync(source.path, Buffer.from(wav).fill(0, 44));
    try { await expect(renderSong(host, score(), { recorded: recording }, opts)).rejects.toThrow(/hash mismatch/); }
    finally { writeFileSync(source.path, wav); }
    rmSync(source.path);
    try { await expect(renderSong(host, score(), { recorded: recording }, opts)).rejects.toThrow(/not found/); }
    finally { writeFileSync(source.path, wav); }
  });
});
