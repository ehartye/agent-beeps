import { describe, expect, it } from 'vitest';
import { momentaryMax } from '../../src/measure/loudness.ts';
import { overviewAudio, overviewLook, segmentMono } from '../../src/samples/overview.ts';
import type { Overview, OverviewSegment } from '../../src/samples/overview.ts';
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
    // 480001 samples is 1000 whole frames and one sample. The window ends 5 frames short of the end: floor((480001 - 2400) / 480) = 995.
    // Frame 996 is the first a 4-frame cap, or a rounded-up one, would allow: cutting there leaves 480001 - 996 * 480 = 1921 samples.
    const dipPastCap = whiteNoise(11, 1, 0.3).slice(0, 480001);
    dipPastCap.fill(0, 996 * 480, 997 * 480);
    check(dipPastCap);
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

  it('rounds --min-gap up, not to nearest', () => {
    // 251 ms is 25.1 frames: rounded up it is 26, which bridges a 25 frame gap; rounded to nearest it is 25, which splits it
    const opts = { gapDb: 40, minGapMs: 251 };
    expect(segmentMono(layout(3, [[1, sine(440, 0.5)], [1.75, sine(440, 0.5)]]), opts)).toHaveLength(1); // 250 ms apart: 25 frames
    expect(segmentMono(layout(3, [[1, sine(440, 0.5)], [1.76, sine(440, 0.5)]]), opts)).toHaveLength(2); // 260 ms apart: 26 frames
  });

  it('cuts only within 6 to 10 s of the piece start', () => {
    // a three-frame dip is bridged (30 ms is under --min-gap), so the noise stays one run and only the cut search sees it
    const late = whiteNoise(15, 3, 0.3);
    late.fill(0, 10.5 * SR, 10.5 * SR + 1440); // 10.5 s in: past the window, which ends at 10 s
    const first = segmentMono(late, DEFAULTS)[0];
    expect(first.endFrame).toBeLessThanOrEqual(10 * SR);
    expect(first.endFrame).not.toBe(10.5 * SR);
    const near = whiteNoise(15, 3, 0.3);
    near.fill(0, 9.9 * SR, 9.9 * SR + 1440); // 9.9 s in: inside the window, and the quietest place in it
    expect(segmentMono(near, DEFAULTS)[0].endFrame).toBe(9.9 * SR);
  });
});

const square = (hz: number, dur: number, amp: number) => Float32Array.from({ length: Math.round(dur * SR) }, (_, i) => (i % Math.round(SR / hz) < SR / hz / 2 ? amp : -amp));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Burst i of a train starts at 0.1 s + i * 0.36 s (a whole number of 10 ms frames), 300 ms after the last one ends, so each burst is its own
 *  segment and starts 20 ms (960 frames) before its onset. */
const burstOnset = (i: number) => Math.round((0.1 + i * 0.36) * SR);
const burstStart = (i: number) => burstOnset(i) - 960;
const train = (n: number, amp: (i: number) => number) => layout(26, Array.from({ length: n }, (_, i): [number, Float32Array] => [0.1 + i * 0.36, sine(440, 0.06, amp(i))]));

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

  it('reports crest, momentary loudness and event count of a segment', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(2000, 0.5)]]);
    const [a] = overviewAudio([x], DEFAULTS).segments;
    expect(a.crestDb).toBeCloseTo(20 * Math.log10(Math.SQRT2), 1); // a sine peaks sqrt 2 times its RMS: 3.01 dB
    expect(a.momentaryMaxLufs).toBe(round2(momentaryMax([x.subarray(47040, 72000)], SR)));
    expect(a.momentaryMaxLufs).toBeCloseTo(-9.72, 1); // mean square 0.125 is -9.03 dB, less 0.691; K-weighting is flat near 440 Hz
    expect(a.events.count).toBe(1); // findEvents finds the one onset of a single burst
    expect(a.events.rpm).toBeNull();
  });

  it('flags clipped, short and cut-at-ten-seconds segments', () => {
    const x = layout(30, [[1, square(480, 0.1, 1)], [3, whiteNoise(15, 2, 0.3)]]);
    const o = overviewAudio([x], DEFAULTS);
    expect(o.segments[0].flags).toEqual(['clipped', 'short']);
    expect(o.segments[0].clippedSamples).toBe(4800); // every sample of the 0.1 s square burst is at plus or minus 1
    const cut = o.segments.slice(1);
    expect(cut.length).toBeGreaterThanOrEqual(2);
    expect(cut[0].flags).toContain('cutAt10s');
    expect(cut[cut.length - 1].flags).not.toContain('cutAt10s');
  });

  it('marks a segment short only under 0.15 s', () => {
    // each burst gets a 20 ms lead: 0.13 s of sound makes exactly 0.15 s, 0.12 s makes 0.14 s
    const o = overviewAudio([layout(5, [[1, sine(440, 0.13)], [3, sine(440, 0.12)]])], DEFAULTS);
    expect(o.segments.map(s => s.durationSec)).toEqual([0.15, 0.14]);
    expect(o.segments.map(s => s.flags)).toEqual([[], ['short']]);
  });

  it('works inside a view range that is not frame-aligned and keeps source time', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(440, 0.5)], [5, sine(440, 0.5)]]);
    const v0 = 2 * SR + 17, v1 = 6 * SR + 17;
    const o = overviewAudio([x], { ...DEFAULTS, startFrame: v0, endFrame: v1 });
    expect(o.view).toEqual({ startFrame: v0, endFrame: v1, startSec: 2.000354, endSec: 6.000354 });
    // The bursts begin 47983 and 143983 frames into the view, inside frames 99 and 299 of 480 frames. A segment starts two frames earlier and
    // ends on the frame boundary after its burst, 72000 and 168000 frames in. The burst at 1 s is before the view.
    expect(o.segments.map(s => [s.startFrame, s.endFrame])).toEqual([[v0 + 97 * 480, v0 + 150 * 480], [v0 + 297 * 480, v0 + 350 * 480]]);
    expect(o.segments.map(s => [s.startSec, s.endSec])).toEqual([[2.970354, 3.500354], [4.970354, 5.500354]]);
    expect(o.segments.map(s => s.durationSec)).toEqual([0.53, 0.53]);
    // whole seconds of the view: 17 samples of the next burst, then half a second of a 0.5 amplitude sine (-12.7 LUFS), twice
    expect(o.arc).toHaveLength(4);
    expect(o.arc[1]).toBeCloseTo(-12.7, 1);
    expect(o.arc[3]).toBeCloseTo(-12.7, 1);
    expect(o.arc[0]).toBeLessThan(-40);
    expect(o.arc[2]).toBeLessThan(-40);
  });

  it('keeps the 64 loudest of more than 64 segments, in time order, and says so', () => {
    // six scattered quiet bursts among distinct louder ones
    const quiet = [3, 17, 29, 41, 55, 68];
    const o = overviewAudio([train(70, i => (quiet.includes(i) ? 0.05 : 0.3 + ((i * 7) % 40) * 0.01))], DEFAULTS);
    expect(o.segments).toHaveLength(64);
    expect(o.omitted).toBe(6);
    const kept = Array.from({ length: 70 }, (_, i) => i).filter(i => !quiet.includes(i)).map(burstStart);
    expect(o.segments.map(s => s.startFrame)).toEqual(kept); // exactly the quiet six are dropped, the rest stay in time order
    expect(o.segments.map(s => s.index)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(o.hints.join(' ')).toMatch(/6 quieter segments omitted.*--min-gap/);
  });

  it('keeps the earliest 64 when more than 64 segments are equally loud', () => {
    const o = overviewAudio([train(70, () => 0.3)], DEFAULTS);
    expect(o.omitted).toBe(6);
    expect(o.segments.map(s => s.startFrame)).toEqual(Array.from({ length: 64 }, (_, i) => burstStart(i)));
  });

  it('says nothing about the cap at exactly 64 segments', () => {
    const o = overviewAudio([train(64, () => 0.3)], DEFAULTS);
    expect(o.segments).toHaveLength(64);
    expect(o.omitted).toBe(0);
    expect(o.hints).toEqual([]);
  });

  it('hints at --gap-db and --min-gap when one continuous sound is cut at ten seconds', () => {
    const o = overviewAudio([whiteNoise(25, 1, 0.3)], DEFAULTS);
    expect(o.hints.join(' ')).toMatch(/--gap-db/);
  });

  it('gives no continuous-sound hint when a real gap precedes the ten-second cuts', () => {
    const o = overviewAudio([layout(30, [[1, sine(440, 0.1)], [3, whiteNoise(15, 2, 0.3)]])], DEFAULTS);
    expect(o.segments[0].flags).not.toContain('cutAt10s');
    expect(o.segments.slice(1).some(s => s.flags.includes('cutAt10s'))).toBe(true);
    expect(o.hints).toEqual([]);
  });

  it('hints when nothing is audible, and has no peak', () => {
    const o = overviewAudio([new Float32Array(SR)], DEFAULTS);
    expect(o.segments).toEqual([]);
    expect(o.hints.join(' ')).toMatch(/-70 dBFS/);
    expect(o.peakDb).toBeNull();
    expect(overviewLook(o).source.peakDb).toBeNull();
  });

  it('says "1 quieter segment omitted" in the singular', () => {
    const o = overviewAudio([train(65, () => 0.3)], DEFAULTS);
    expect(o.omitted).toBe(1);
    expect(o.hints.join(' ')).toMatch(/^1 quieter segment omitted/);
  });

  it('explains that anti-phase stereo cancels in the mono mix it measures', () => {
    const left = layout(3, [[1, sine(440, 0.5)]]), right = left.map(v => -v);
    const o = overviewAudio([left, right], DEFAULTS);
    expect(o.segments).toEqual([]);
    expect(o.hints.join(' ')).toMatch(/-70 dBFS in the view \(measured on the mono mix\)/);
  });

  it('refuses a source with no channels', () => {
    expect(() => overviewAudio([], DEFAULTS)).toThrow(RangeError);
    expect(() => overviewAudio([], DEFAULTS)).toThrow('overview needs at least one channel');
  });

  it('measures stereo sources without throwing', () => {
    const x = layout(3, [[1, sine(440, 0.5)]]);
    expect(overviewAudio([x, x], DEFAULTS).segments).toHaveLength(1);
  });

  it('reports the loudest channel peak, not the mono mix, when one channel is silent', () => {
    const x = layout(3, [[1, sine(440, 0.5)]]);
    const o = overviewAudio([x, new Float32Array(x.length)], DEFAULTS);
    expect(o.segments).toHaveLength(1);
    expect(o.segments[0].peakDb).toBeCloseTo(-6.02, 1); // the mono mix would peak at 0.25: -12.04
    expect(o.peakDb).toBeCloseTo(-6.02, 1);
    expect(o.segments[0].centroidHz).toBeGreaterThanOrEqual(400);
    expect(o.segments[0].centroidHz).toBeLessThanOrEqual(480);
  });

  it('counts clipped samples in every channel', () => {
    // left is 0.1 s of square at full scale, right 0.05 s of it: 4800 + 2400 samples at plus or minus 1
    const left = layout(3, [[1, square(480, 0.1, 1)]]), right = layout(3, [[1, square(480, 0.05, 1)]]);
    const o = overviewAudio([left, right], DEFAULTS);
    expect(o.segments).toHaveLength(1);
    expect(o.segments[0].clippedSamples).toBe(7200);
    expect(o.segments[0].flags).toContain('clipped');
  });

  it('ranks the segment cap by the mono mix, not by the loudest channel', () => {
    // Burst 35 is 0.7 on the left only: loudest channel peak 0.7, mono mix 0.35. Five bursts are 0.3 on both channels. The rest are 0.4 on
    // both. By mono mix the six lowest are the five 0.3 bursts and burst 35; ranked by channel peak, burst 35 would stay and a 0.4 burst go.
    const quiet = [5, 15, 25, 45, 55], oneSided = 35;
    const left = train(70, i => (i === oneSided ? 0.7 : quiet.includes(i) ? 0.3 : 0.4));
    const right = train(70, i => (i === oneSided ? 0 : quiet.includes(i) ? 0.3 : 0.4));
    const o = overviewAudio([left, right], DEFAULTS);
    const dropped = new Set([...quiet, oneSided]);
    expect(o.omitted).toBe(6);
    expect(o.segments.map(s => s.startFrame)).toEqual(Array.from({ length: 70 }, (_, i) => i).filter(i => !dropped.has(i)).map(burstStart));
  });
});

describe('overviewLook', () => {
  it('gives view-relative bands that are exact in frames, with the arc and source passed through', () => {
    const x = layout(7, [[1, sine(440, 0.5)], [3, sine(440, 0.5)], [5, sine(440, 0.5)]]);
    const o = overviewAudio([x], { ...DEFAULTS, startFrame: 2 * SR + 17, endFrame: 6 * SR + 17 });
    const look = overviewLook(o);
    // subtracting the view start from the segment time in seconds would leave 0.9699999999999998 here
    expect(look.sections).toEqual([
      { name: '1', start: 0.97, end: 1.5, lufs: -9.71, centroidHz: 440 },
      { name: '2', start: 2.97, end: 3.5, lufs: -9.71, centroidHz: 440 },
    ]);
    expect(look.arc).toEqual(o.arc);
    expect(look.source).toEqual({ startSec: 2.000354, endSec: 6.000354, peakDb: -6.02 });
  });

  it('uses -70 LUFS for a segment with no momentary loudness', () => {
    const segment: OverviewSegment = {
      index: 7, startFrame: 72000, endFrame: 96000, startSec: 1.5, endSec: 2, durationSec: 0.5, peakDb: -12, momentaryMaxLufs: null,
      crestDb: 3, centroidHz: 1000, clippedSamples: 0, events: { count: 0, rpm: null }, flags: [],
    };
    const o: Overview = { view: { startFrame: SR, endFrame: 3 * SR, startSec: 1, endSec: 3 }, peakDb: -12, segments: [segment], omitted: 0, hints: [], arc: [-20, -30] };
    expect(overviewLook(o)).toEqual({
      sections: [{ name: '7', start: 0.5, end: 1, lufs: -70, centroidHz: 1000 }],
      arc: [-20, -30],
      source: { startSec: 1, endSec: 3, peakDb: -12 },
    });
  });
});
