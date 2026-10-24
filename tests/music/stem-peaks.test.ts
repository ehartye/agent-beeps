// `song stems` says which track sets the mix's peaks, so a peak-limited mix can be fixed by lowering the right part.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributePeaks, loudestFrames } from '../../src/stem-peaks.ts';
import { initProject } from '../../src/project.ts';
import { chromiumAvailable } from '../../src/render/host.ts';
import { songInput } from '../helpers/songs.ts';

const SR = 1000;
const silence = (n: number) => [new Float32Array(n)];
const put = (chs: Float32Array[], i: number, v: number) => { chs[0][i] = v; };

describe('loudestFrames', () => {
  it('returns the highest peaks, one per gap, loudest first', () => {
    const mix = silence(3000);
    put(mix, 100, 0.2); put(mix, 150, 0.9); put(mix, 1200, 0.5); put(mix, 2500, 0.7);
    // 0.1 s at 1 kHz is a 100-frame window: 100 and 150 share one, so only the 0.9 survives
    expect(loudestFrames(mix, SR, 3, 0.1)).toEqual([150, 2500, 1200]);
  });
  it('ignores silence', () => { expect(loudestFrames(silence(500), SR, 5, 0.1)).toEqual([]); });
});

describe('attributePeaks', () => {
  it('names the stem that is loudest where the mix peaks, and counts it', () => {
    const kick = silence(3000), pad = silence(3000), mix = silence(3000);
    for (const i of [100, 1100, 2100]) { put(kick, i, 0.8); put(pad, i, 0.1); put(mix, i, 0.85); }
    put(pad, 1500, 0.3); put(mix, 1500, 0.3);
    const a = attributePeaks(mix, SR, ['kick', 'pad'], t => (t === 'kick' ? kick : pad), { count: 4, gapSec: 0.1 });
    expect(a.setBy[0]).toMatchObject({ track: 'kick', peaks: 3 });
    expect(a.setBy[1]).toMatchObject({ track: 'pad', peaks: 1 });
    expect(a.moments[0]).toMatchObject({ track: 'kick', at: 0.1 });
    expect(a.moments[0].stemDb).toBeCloseTo(-1.9, 1);
    // the pad's one peak is far under the kick's, so only the kick limits the trim
    expect(a.limiting).toEqual([{ track: 'kick', peaks: 3 }]);
  });

  it('loads one stem at a time and counts a stem whose peak lands a sample away', () => {
    const mix = silence(1000), stem = silence(1000);
    put(mix, 500, 0.9); put(stem, 501, 0.8);
    const loaded: string[] = [];
    const a = attributePeaks(mix, SR, ['a'], t => { loaded.push(t); return stem; }, { count: 1, gapSec: 0.1 });
    expect(loaded).toEqual(['a']);
    expect(a.setBy).toEqual([{ track: 'a', peaks: 1, share: 1 }]);
  });

  it('is empty for a silent mix', () => { expect(attributePeaks(silence(100), SR, ['a'], () => silence(100))).toEqual({ moments: [], setBy: [], limiting: [] }); });
});

const hasChromium = await chromiumAvailable();
describe.skipIf(!hasChromium)('song stems peaks', () => {
  it('reports the track that makes the mix peak', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-peaks-'));
    initProject(dir);
    const bin = join(import.meta.dirname, '..', '..', 'scripts/beeps.mjs');
    // A soft pad under a loud, sparse click: the click sets every peak.
    const song = songInput({
      tracks: {
        pad: { instrument: { schema: 'beeps/patch@1', name: 'soft', family: 'music', duration: 1, layers: [{ source: { type: 'osc', wave: 'sine', pitch: 'C4' }, amp: { attack: 0.1, decay: 0.5, sustain: 0.8, release: 0.3 }, gainDb: -14 }] }, gainDb: -6 },
        click: { instrument: { schema: 'beeps/patch@1', name: 'click', family: 'music', duration: 0.05, layers: [{ source: { type: 'noise', color: 'white' }, amp: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 } }] }, gainDb: 0 },
      },
      patterns: { 'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 } }, 'click-a': { bars: 1, steps: 'x... .... x... ....' } },
      sections: { a: { bars: 2, play: { pad: 'pad-a', click: 'click-a' } } },
    });
    const file = join(dir, 'peaky.json');
    writeFileSync(file, JSON.stringify(song));
    const r = spawnSync(process.execPath, [bin, 'song', 'stems', file], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.peaks.count).toBeGreaterThan(0);
    // the pad has more loud-ish windows, but only the click is within a dB of the loudest peak: that is what a peak-limited trim would be stuck on
    expect(out.peaks.limiting[0].track).toBe('click');
    expect(out.peaks.loudest.track).toBe('click');
  }, 300000);
});
