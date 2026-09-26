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
