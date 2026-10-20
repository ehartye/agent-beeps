import { describe, expect, it } from 'vitest';
import { chromiumAvailable, openRenderHost } from '../../src/render/host.ts';
import { SR } from '../helpers/signals.ts';

const hasChromium = await chromiumAvailable();
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('overview image footer', () => {
  it.skipIf(!hasChromium)('draws a different footer when the features carry a source', async () => {
    let state = 1;
    const noise = new Float32Array(3 * SR);
    for (let i = 0; i < noise.length; i++) { state = (state * 1664525 + 1013904223) >>> 0; noise[i] = 0.3 * (state / 2 ** 31 - 1) * (i > SR / 2 && i < 1.5 * SR ? 1 : 0.05); }
    const base = { sections: [{ name: '1', start: 0.5, end: 1.5, lufs: -20, centroidHz: 1000 }], arc: [-30, -30, -30] };
    const host = await openRenderHost();
    try {
      const song = await host.songPcmLook([noise], base, 'label');
      const source = await host.songPcmLook([noise], { ...base, source: { startSec: 0, endSec: 3, peakDb: -6 } }, 'label');
      for (const png of [song, source]) expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
      expect(source.equals(song)).toBe(false);
    } finally { await host.close(); }
  });
});
