import { describe, expect, it } from 'vitest';
import { seamMetrics, seamWarning } from '../../src/measure/seam.ts';
import { lintSong } from '../../src/song-lint.ts';
import { defaultProject } from '../../src/schema/project.ts';
import type { SongFeatures } from '../../src/measure/song.ts';
import { song } from '../helpers/songs.ts';

const SR = 48000;
/** A loop that wraps exactly: whole cycles in the file. */
const periodic = (sec = 1, cycles = 220): Float32Array => Float32Array.from({ length: SR * sec }, (_, i) => 0.3 * Math.sin(2 * Math.PI * cycles * i / (SR * sec)));

describe('seamMetrics', () => {
  it('reads a periodic loop as an ordinary step with the last crossing at the end', () => {
    const m = seamMetrics([periodic(), periodic()]);
    expect(m.boundaryStepDb).toBeLessThan(10);
    expect(m.slopeJumpDb).toBeLessThan(10);
    // the loop ends one sample before the cycle completes: phase within a sample of 0 or 1
    expect(Math.min(m.lastZeroCrossingPhase!, 1 - m.lastZeroCrossingPhase!)).toBeLessThan(0.02);
  });
  it('sees a step at the wrap as many typical steps, and a kinked slope separately', () => {
    const a = periodic(); a[a.length - 1] = 0.9;
    expect(seamMetrics([a]).boundaryStepDb).toBeGreaterThan(20);
    const half = Float32Array.from({ length: SR }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 220.25 * i / SR));
    expect(seamMetrics([half]).boundaryStepDb).toBeGreaterThan(seamMetrics([periodic()]).boundaryStepDb);
  });
  it('does not fail on silence or a tiny file', () => {
    expect(seamMetrics([new Float32Array(1000)])).toMatchObject({ boundaryStepDb: 0, slopeJumpDb: 0 });
    expect(seamMetrics([new Float32Array(3)])).toEqual({ boundaryStepDb: 0, slopeJumpDb: 0 });
  });
});

describe('seamWarning', () => {
  it('warns only when the delivered seam is more than 3 dB worse than the source', () => {
    const at = (boundaryStepDb: number) => ({ boundaryStepDb, slopeJumpDb: 0 });
    expect(seamWarning(at(4), at(6.5))).toBeUndefined();
    expect(seamWarning(at(4), at(2))).toBeUndefined();
    expect(seamWarning(at(4), at(7.5))).toMatch(/3\.5 dB more than the source/);
  });
});

describe('song-loop-boundary-step', () => {
  const f = (boundaryStepDb: number): SongFeatures => ({
    durationSec: 90, integratedLufs: -24, shortTermMaxLufs: -18, loudnessRangeLu: 8, samplePeakDb: -6, truePeakDb: -5.8, crestDb: 14,
    centroidHz: 1200, flatness: 0.1, bands: [], lowShare: 0.2, stereoWidth: 0.4, arc: [], sections: [],
    delivered: { integratedLufs: -20, truePeakDb: -2, clippedSamples: 0 }, seam: { boundaryStepDb, slopeJumpDb: 3 },
  });
  it('warns, never errors, on a loop with a hard step at the wrap', () => {
    const r = lintSong(song({ loop: true }), f(30), defaultProject());
    expect(r.errors).toEqual([]);
    expect(r.warnings.map(w => w.rule)).toContain('song-loop-boundary-step');
    expect(lintSong(song({ loop: true }), f(5), defaultProject()).warnings.map(w => w.rule)).not.toContain('song-loop-boundary-step');
  });
});
