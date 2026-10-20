import { describe, expect, it } from 'vitest';
import { overviewAudio, segmentMono } from '../../src/samples/overview.ts';
import { SR, sine, whiteNoise } from '../helpers/signals.ts';

const DEFAULTS = { gapDb: 40, minGapMs: 200 };
/** Silence of `total` seconds with each part copied in at its start time. */
const layout = (total: number, parts: [number, Float32Array][]) => {
  const out = new Float32Array(Math.round(total * SR));
  for (const [t, x] of parts) out.set(x, Math.round(t * SR));
  return out;
};

describe('segmentMono', () => {
  it('cuts three bursts at their gaps, 20 ms before each onset', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(440, 0.5)], [5, sine(440, 0.5)]]);
    expect(segmentMono(x, DEFAULTS)).toEqual([
      { startFrame: 47040, endFrame: 72000, cutAt10s: false },
      { startFrame: 143040, endFrame: 168000, cutAt10s: false },
      { startFrame: 239040, endFrame: 264000, cutAt10s: false },
    ]);
  });

  it('bridges a gap shorter than --min-gap and splits at exactly --min-gap', () => {
    const bridged = layout(3, [[1, sine(440, 0.5)], [1.6, sine(440, 0.5)]]); // 100 ms apart
    expect(segmentMono(bridged, DEFAULTS)).toEqual([{ startFrame: 47040, endFrame: 100800, cutAt10s: false }]);
    const split = layout(3, [[1, sine(440, 0.5)], [1.7, sine(440, 0.5)]]); // 200 ms apart
    expect(segmentMono(split, DEFAULTS)).toHaveLength(2);
  });

  it('drops a click shorter than 50 ms', () => {
    const click = new Float32Array(1); click[0] = 0.5;
    const x = layout(6, [[2, click], [4, sine(440, 0.5)]]);
    expect(segmentMono(x, DEFAULTS)).toEqual([{ startFrame: 191040, endFrame: 216000, cutAt10s: false }]);
  });

  it('keeps a quiet burst until --gap-db excludes it', () => {
    const x = layout(5, [[1, sine(440, 0.5)], [3, sine(440, 0.5, 0.01)]]); // about 34 dB under the loud one
    expect(segmentMono(x, DEFAULTS)).toHaveLength(2);
    expect(segmentMono(x, { gapDb: 20, minGapMs: 200 })).toHaveLength(1);
  });

  it('returns nothing for silence or a signal under -70 dBFS', () => {
    expect(segmentMono(new Float32Array(SR), DEFAULTS)).toEqual([]);
    expect(segmentMono(Float32Array.from({ length: SR }, () => 1e-4), DEFAULTS)).toEqual([]);
  });

  it('cuts continuous sound into pieces of at most ten seconds at quiet frames', () => {
    const x = whiteNoise(25, 1, 0.3);
    const cuts = segmentMono(x, DEFAULTS);
    // pieces are 6 to 10 s long, so 25 s needs at least ceil(25/10) = 3 and at most floor(25/6) = 4
    expect(cuts.length).toBeGreaterThanOrEqual(3);
    expect(cuts.length).toBeLessThanOrEqual(4);
    expect(cuts[0].startFrame).toBe(0);
    expect(cuts[cuts.length - 1].endFrame).toBe(25 * SR);
    cuts.forEach((c, i) => {
      expect(c.endFrame - c.startFrame).toBeLessThanOrEqual(10 * SR);
      expect(c.cutAt10s).toBe(i < cuts.length - 1);
      if (i < cuts.length - 1) {
        expect(cuts[i + 1].startFrame).toBe(c.endFrame); // contiguous
        expect(c.endFrame - c.startFrame).toBeGreaterThanOrEqual(6 * SR);
      }
    });
  });

  it('cuts a long run at the quietest frame 6 to 10 s in, and ignores a dip outside that window', () => {
    const inWindow = whiteNoise(15, 3, 0.3);
    inWindow.fill(0, 8 * SR, 8 * SR + 1440); // 8.00 to 8.03 s: three silent frames, bridged, not a gap
    expect(segmentMono(inWindow, DEFAULTS)[0].endFrame).toBe(8 * SR);
    const outside = whiteNoise(15, 3, 0.3);
    outside.fill(0, 5 * SR, 5 * SR + 1440);
    const first = segmentMono(outside, DEFAULTS)[0];
    expect(first.endFrame).not.toBe(5 * SR);
    expect(first.endFrame).toBeGreaterThanOrEqual(6 * SR);
  });

  it('never leaves a final piece under 50 ms when splitting', () => {
    const check = (x: Float32Array) => {
      const cuts = segmentMono(x, DEFAULTS);
      expect(cuts.length).toBeGreaterThanOrEqual(2);
      expect(cuts[0].startFrame).toBe(0);
      expect(cuts[cuts.length - 1].endFrame).toBe(x.length);
      cuts.forEach((c, i) => {
        expect(c.endFrame - c.startFrame).toBeGreaterThanOrEqual(2400);
        if (i > 0) expect(c.startFrame).toBe(cuts[i - 1].endFrame);
      });
    };
    const flat = whiteNoise(11, 1, 0.3).slice(0, 480001);
    flat[480000] = 0.01; // a one-sample last frame, the quietest in the window
    check(flat);
    const dipAtTen = whiteNoise(11, 2, 0.3).slice(0, 481000);
    dipAtTen.fill(0, 480000, 480480); // frame 1000: the quietest frame is exactly at 10 s
    check(dipAtTen);
  });

  it('keeps a hiss under -70 dBFS as a gap whatever --gap-db says', () => {
    const x = layout(4, [[1, sine(440, 0.5, 0.5)], [3, whiteNoise(0.5, 4, 1.7e-4)]]); // about -80 dBFS RMS
    expect(segmentMono(x, { gapDb: 100, minGapMs: 200 })).toHaveLength(1);
  });

  it('ends the last segment at the signal end when the length is not a whole number of frames', () => {
    const x = new Float32Array(3 * SR + 100);
    x.set(sine(440, 48100 / SR), 2 * SR);
    expect(segmentMono(x, DEFAULTS)).toEqual([{ startFrame: 2 * SR - 960, endFrame: 3 * SR + 100, cutAt10s: false }]);
  });

  it('rounds --min-gap up to whole 10 ms frames', () => {
    const opts = { gapDb: 40, minGapMs: 255 }; // 26 frames
    expect(segmentMono(layout(3, [[1, sine(440, 0.5)], [1.75, sine(440, 0.5)]]), opts)).toHaveLength(1); // 250 ms apart
    expect(segmentMono(layout(3, [[1, sine(440, 0.5)], [1.76, sine(440, 0.5)]]), opts)).toHaveLength(2); // 260 ms apart
  });
});

const square = (hz: number, dur: number, amp: number) => Float32Array.from({ length: Math.round(dur * SR) }, (_, i) => (i % Math.round(SR / hz) < SR / hz / 2 ? amp : -amp));

describe('overviewAudio', () => {
  it('measures each segment and reports exact frames and times', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(2000, 0.5)]]);
    const o = overviewAudio([x], DEFAULTS);
    expect(o.view).toEqual({ startFrame: 0, endFrame: 7 * SR, startSec: 0, endSec: 7 });
    expect(o.segments).toHaveLength(2);
    const [a, b] = o.segments;
    expect(a).toMatchObject({ index: 1, startFrame: 47040, endFrame: 72000, startSec: 0.98, endSec: 1.5, durationSec: 0.52, clippedSamples: 0, flags: [] });
    expect(a.peakDb).toBeCloseTo(-6, 0);
    expect(a.centroidHz).toBeGreaterThan(300);
    expect(a.centroidHz).toBeLessThan(600);
    expect(b.centroidHz).toBeGreaterThan(1500);
    expect(b.index).toBe(2);
    expect(o.peakDb).toBeCloseTo(-6, 0);
    expect(o.arc).toHaveLength(7);
    expect(o.omitted).toBe(0);
    expect(o.hints).toEqual([]);
  });

  it('flags clipped, short and cut-at-ten-seconds segments', () => {
    const x = layout(30, [[1, square(480, 0.1, 1)], [3, whiteNoise(15, 2, 0.3)]]);
    const o = overviewAudio([x], DEFAULTS);
    expect(o.segments[0].flags).toEqual(['clipped', 'short']);
    expect(o.segments[0].clippedSamples).toBeGreaterThan(0);
    const cut = o.segments.slice(1);
    expect(cut.length).toBeGreaterThanOrEqual(2);
    expect(cut[0].flags).toContain('cutAt10s');
    expect(cut[cut.length - 1].flags).not.toContain('cutAt10s');
  });

  it('works inside a view range and keeps source time', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(440, 0.5)], [5, sine(440, 0.5)]]);
    const o = overviewAudio([x], { ...DEFAULTS, startFrame: 2 * SR, endFrame: 6 * SR });
    expect(o.view).toMatchObject({ startSec: 2, endSec: 6 });
    expect(o.segments.map(s => s.startFrame)).toEqual([143040, 239040]);
    expect(o.arc).toHaveLength(4);
  });

  it('keeps the 64 loudest of more than 64 segments, in time order, and says so', () => {
    const parts: [number, Float32Array][] = Array.from({ length: 70 }, (_, i) => [0.1 + i * 0.36, sine(440, 0.06, 0.1 + i * 0.01)]);
    const o = overviewAudio([layout(26, parts)], DEFAULTS);
    expect(o.segments).toHaveLength(64);
    expect(o.omitted).toBe(6);
    expect(o.segments[0].startSec).toBeCloseTo(2.24, 2); // bursts 0 to 5 are the quietest
    expect(o.segments.map(s => s.index)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(o.hints.join(' ')).toMatch(/--min-gap/);
  });

  it('hints at --gap-db and --min-gap when one continuous sound is cut at ten seconds', () => {
    const o = overviewAudio([whiteNoise(25, 1, 0.3)], DEFAULTS);
    expect(o.hints.join(' ')).toMatch(/--gap-db/);
  });

  it('hints when nothing is audible', () => {
    const o = overviewAudio([new Float32Array(SR)], DEFAULTS);
    expect(o.segments).toEqual([]);
    expect(o.hints.join(' ')).toMatch(/-70 dBFS/);
  });

  it('measures stereo sources without throwing', () => {
    const x = layout(3, [[1, sine(440, 0.5)]]);
    expect(overviewAudio([x, x], DEFAULTS).segments).toHaveLength(1);
  });
});
