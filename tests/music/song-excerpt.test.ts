import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/audio/wav.ts';
import { excerptWav, renderSongExcerpt } from '../../src/render/song-excerpt.ts';
import { chromiumAvailable, openRenderHost, type RenderHost } from '../../src/render/host.ts';
import { renderSong } from '../../src/render/song-pipeline.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { patch } from '../helpers/patches.ts';
import { PAD, HAT, song } from '../helpers/songs.ts';

describe('delivered audio excerpts', () => {
  const sr = 48000;
  const channels = [Float32Array.from({ length: sr * 3 }, (_, i) => Math.sin(i / 37) * 0.3)];
  const wav = writeWav(channels, sr);
  const sections = [{ name: 'a', start: 0, end: 1 }, { name: 'b', start: 1, end: 2 }, { name: 'a', start: 2, end: 3 }];

  it('copies exact PCM bytes at their original level for every selected occurrence', () => {
    const r = excerptWav(wav, sections, ['a']);
    expect(r.wav.subarray(44)).toEqual(Buffer.concat([wav.subarray(44, 44 + sr * 2), wav.subarray(44 + sr * 4)]));
    expect(r.wav.readUInt32LE(40)).toBe(sr * 4);
    expect(r.sections).toEqual([{ name: 'a', start: 0, end: 1 }, { name: 'a', start: 1, end: 2 }]);
    expect(r.sourceRanges).toEqual([{ name: 'a', start: 0, end: 1 }, { name: 'a', start: 2, end: 3 }]);
  });

  it('rejects unplayed/unknown sections and an empty selection', () => {
    expect(() => excerptWav(wav, sections, ['nope'])).toThrow(/no played section/);
    expect(() => excerptWav(wav, sections, [])).toThrow(/select at least one/);
  });
});

describe.skipIf(!(await chromiumAvailable()))('faithful preview render', () => {
  let host: RenderHost;
  beforeAll(async () => { host = await openRenderHost(); });
  afterAll(async () => { await host?.close(); });

  it('retains earlier automation and effect tails by excerpting the delivered full song', async () => {
    const s = song({
      loop: true,
      tracks: { pad: { instrument: 'pad', sends: { reverb: -6 } }, hat: { instrument: 'hat' } },
      sections: {
        a: { bars: 2, play: { pad: 'pad-a', hat: 'hat-a' }, mix: { pad: { gainDb: -12, cutoff: 700 } } },
        b: { bars: 2, play: { pad: 'pad-a' } },
      }, form: ['a', 'b'], master: { reverb: { preset: 'hall' } },
    });
    const full = await renderSong(host, s, { pad: patch(PAD), hat: patch(HAT) }, {
      project: defaultProject(), rendersDir: mkdtempSync(join(tmpdir(), 'beeps-excerpt-')),
    });
    const preview = await renderSongExcerpt(host, full, ['b']);
    const originalWav = readFileSync(full.wavPath), previewWav = readFileSync(preview.wavPath);
    expect(previewWav.subarray(44)).toEqual(originalWav.subarray(44 + 4 * 48000 * 4));
    expect(preview.features.durationSec).toBe(4);
    expect(preview.trimDb).toBe(full.trimDb);
    expect(preview.excerpt?.sourceKey).toBe(full.key);
    expect(preview.song.loop).toBe(false);
    expect(readFileSync(preview.lookPath).subarray(1, 4).toString()).toBe('PNG');
    expect((await renderSongExcerpt(host, full, ['b'])).cached).toBe(true);
  });
});
