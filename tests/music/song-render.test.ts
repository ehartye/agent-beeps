import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import { renderSong } from '../../src/render/song-pipeline.ts';
import { readWav } from '../../src/audio/wav.ts';
import { integrated } from '../../src/measure/loudness.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { patch } from '../helpers/patches.ts';
import { HAT, PAD, song } from '../helpers/songs.ts';

describe.skipIf(!(await chromiumAvailable()))('song render', () => {
  let host: RenderHost;
  const project = defaultProject();
  const rendersDir = mkdtempSync(join(tmpdir(), 'beeps-songs-'));
  const instruments = { pad: patch(PAD), hat: patch(HAT) };
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it('preserves a four-beat delay at the slowest supported tempo in Chromium', async () => {
    const s = song({ bpm: 30, master: { delay: { beats: 4 } } });
    const seconds = await host.page.evaluate(async ({ s, instruments }) => {
      const { buildSong } = await new Function("return import('/engine/song.js')")();
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const createDelay = ctx.createDelay.bind(ctx);
      let line: DelayNode;
      ctx.createDelay = max => { line = createDelay(max); return line; };
      buildSong(ctx, s, instruments);
      return line!.delayTime.value;
    }, { s, instruments });
    expect(seconds).toBe(8);
  });

  it.each([false, true])('keeps a late patch-duration sound through its release (loop=%s)', async loop => {
    const pulse = patch({ schema: 'beeps/patch@1', name: 'pulse', family: 'music', duration: 2,
      layers: [{ source: { type: 'osc', wave: 'sine', pitch: 220 }, amp: { attack: 0.005, decay: 0.1, sustain: 1, release: 0.1 } }] });
    const s = song({ loop, tracks: { pulse: { instrument: 'pulse' } },
      patterns: { hit: { bars: 1, steps: '...............x', gate: 'patch' } },
      sections: { a: { bars: 1, play: { pulse: 'hit' } } }, form: ['a'] });
    const r = await host.renderSong(s, { pulse });
    try {
      const [ch] = await host.pullSong(r.id, r.frames);
      const peak = (start: number, end: number) => ch.subarray(Math.round(start * r.sampleRate), Math.round(end * r.sampleRate)).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      if (loop) {
        expect(r.frames).toBe(2 * r.sampleRate);
        expect(peak(0.5, 0.6)).toBeGreaterThan(0.1); // tail folds onto the next loop
      } else {
        expect(r.frames / r.sampleRate).toBeGreaterThanOrEqual(3.975);
        expect(peak(3, 3.1)).toBeGreaterThan(0.1);
        expect(peak(r.frames / r.sampleRate - 0.1, r.frames / r.sampleRate)).toBeLessThan(0.00001);
      }
    } finally { await host.freeSong(r.id); }
  });

  it('renders, trims to the music loudness target and draws a look', async () => {
    const s = song({ form: ['a', 'a', 'a'], master: { reverb: { preset: 'hall', returnDb: -6 } }, tracks: { pad: { instrument: 'pad', sends: { reverb: -6 } }, hat: { instrument: 'hat', gainDb: -8 } } });
    const r = await renderSong(host, s, instruments, { project, rendersDir });
    const { channels, sampleRate } = readWav(readFileSync(r.wavPath));
    expect(channels).toHaveLength(2);
    expect(integrated(channels, sampleRate).lufs).toBeCloseTo(project.musicLoudness, 0);
    expect(r.features.delivered!.truePeakDb).toBeLessThanOrEqual(-1);
    expect(r.features.sections.map(x => x.name)).toEqual(['a', 'a', 'a']);
    expect(channels[0].length / sampleRate).toBeGreaterThan(12 + 2); // form + hall tail
    expect(readFileSync(r.lookPath).subarray(1, 4).toString()).toBe('PNG');
    const again = await renderSong(host, s, instruments, { project, rendersDir });
    expect(again.cached).toBe(true);
  }, 60000);

  it('folds a loop song to exactly its form length', async () => {
    const s = song({ loop: true, form: ['a', 'a'], master: { reverb: { preset: 'hall' } }, tracks: { pad: { instrument: 'pad', sends: { reverb: -6 } }, hat: { instrument: 'hat' } } });
    const r = await renderSong(host, s, instruments, { project, rendersDir });
    const { channels, sampleRate } = readWav(readFileSync(r.wavPath));
    expect(channels[0].length).toBe(8 * sampleRate);
    expect(r.features.seamDb).toBeLessThan(6);
  }, 60000);
});
