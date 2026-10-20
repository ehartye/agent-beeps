import { describe, expect, it } from 'vitest';
import { chromiumAvailable, openRenderHost } from '../../src/render/host.ts';
import { sourceFooter } from '../../runtime/look.js';
import { SR } from '../helpers/signals.ts';

const hasChromium = await chromiumAvailable();
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('overview image footer', () => {
  it.skipIf(!hasChromium)('draws a different footer when the features carry a source', async () => {
    let state = 1;
    const noise = new Float32Array(3 * SR);
    for (let i = 0; i < noise.length; i++) { state = (state * 1664525 + 1013904223) >>> 0; noise[i] = 0.3 * (state / 2 ** 31 - 1) * (i > SR / 2 && i < 1.5 * SR ? 1 : 0.05); }
    const base = { sections: [{ name: '1', start: 0.5, end: 1.5, lufs: -20, centroidHz: 1000 }], arc: [-30, -30, -30] };
    const withSource = { ...base, source: { startSec: 0, endSec: 3, peakDb: -6 } };
    const host = await openRenderHost();
    try {
      const song = await host.songPcmLook([noise], base, 'label');
      const source = await host.songPcmLook([noise], withSource, 'label');
      for (const png of [song, source]) expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
      // Positive controls: identical features render identical bytes, so a difference below comes from the footer, not the renderer.
      expect((await host.songPcmLook([noise], base, 'label')).equals(song)).toBe(true);
      expect((await host.songPcmLook([noise], withSource, 'label')).equals(source)).toBe(true);
      expect(source.equals(song)).toBe(false);
    } finally { await host.close(); }
  });
});

describe('sourceFooter', () => {
  const sec = (i: number) => ({ name: String(i + 1), start: i, end: i + 0.5, lufs: -20.04, centroidHz: 1234.4 });
  const feats = (n: number, source = { startSec: 8, endSec: 20, peakDb: -6.03 as number | null }) => ({ sections: Array.from({ length: n }, (_, i) => sec(i)), source });

  it('writes the range, peak and segment count, with the singular for one', () => {
    expect(sourceFooter(feats(4), 12).line).toBe('0:12  source 8.0-20.0 s  peak -6.0 dBFS  4 segments');
    expect(sourceFooter(feats(1), 12).line).toMatch(/ 1 segment$/);
    expect(sourceFooter(feats(0), 12).line).toMatch(/ 0 segments$/);
  });

  it('shows a dash for a missing peak', () => {
    expect(sourceFooter(feats(2, { startSec: 0, endSec: 5, peakDb: null }), 5).line).toBe('0:05  source 0.0-5.0 s  peak – dBFS  2 segments');
  });

  it('lists every section on up to two lines with no marker when they fit', () => {
    const { sectionLines } = sourceFooter(feats(4), 12);
    expect(sectionLines).toEqual(['1 -20.0/1234Hz  2 -20.0/1234Hz  3 -20.0/1234Hz  4 -20.0/1234Hz']);
    expect(sourceFooter(feats(20), 12).sectionLines).toHaveLength(2);
  });

  // Every drawn item is a whole "name lufs/centroidHz"; count them by re-joining the lines.
  const drawn = (lines: string[]) => lines.filter(l => !l.startsWith('...')).join('  ').split('  ').filter(Boolean);
  const whole = (item: string) => /^\d+ -20\.0\/1234Hz$/.test(item);

  it('puts a few segments on line one with no marker', () => {
    const { sectionLines } = sourceFooter(feats(5), 12);
    expect(sectionLines).toHaveLength(1);
    expect(drawn(sectionLines)).toHaveLength(5);
  });

  it('wraps onto line two at a whole item without splitting any', () => {
    const { sectionLines } = sourceFooter(feats(18), 12);
    expect(sectionLines).toHaveLength(2);
    for (const l of sectionLines) { expect(l.length).toBeLessThanOrEqual(190); expect(l.endsWith(' ')).toBe(false); }
    expect(drawn(sectionLines)).toHaveLength(18);
    expect(drawn(sectionLines).every(whole)).toBe(true);
  });

  it('keeps two whole-item lines and a marker with the true count for 64 segments', () => {
    const { sectionLines } = sourceFooter(feats(64), 12);
    expect(sectionLines).toHaveLength(3);
    expect(sectionLines[2]).toBe('... 64 segments in all, see the JSON');
    for (const l of sectionLines.slice(0, 2)) expect(l.length).toBeLessThanOrEqual(190);
    const items = drawn(sectionLines);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(64);
    expect(items.every(whole)).toBe(true);
    expect(items.map(i => i.split(' ')[0])).toEqual(items.map((_, i) => String(i + 1)));
  });

  it('says how many segments there are in all when the list is cut', () => {
    const { sectionLines } = sourceFooter(feats(40), 12);
    expect(sectionLines).toHaveLength(3);
    expect(sectionLines[2]).toBe('... 40 segments in all, see the JSON');
    expect(sourceFooter(feats(64), 12).sectionLines[2]).toBe('... 64 segments in all, see the JSON');
  });
});
