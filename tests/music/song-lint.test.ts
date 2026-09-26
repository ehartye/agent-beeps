import { describe, expect, it } from 'vitest';
import { lintSong } from '../../src/song-lint.ts';
import { defaultProject } from '../../src/schema/project.ts';
import type { SongFeatures } from '../../src/measure/song.ts';
import { song } from '../helpers/songs.ts';

const good = (over: Partial<SongFeatures> = {}): SongFeatures => ({
  durationSec: 90, integratedLufs: -24, shortTermMaxLufs: -18, loudnessRangeLu: 8, samplePeakDb: -6, truePeakDb: -5.8, crestDb: 14,
  centroidHz: 1200, flatness: 0.1, bands: [], lowShare: 0.2, stereoWidth: 0.4, arc: [], sections: [],
  delivered: { integratedLufs: -20, truePeakDb: -2, clippedSamples: 0 }, ...over,
});
const ids = (r: ReturnType<typeof lintSong>) => [...r.errors, ...r.warnings].map(f => f.rule);
const project = defaultProject();

describe('song lint', () => {
  it('passes a well-made song and lists the judgement rules', () => {
    const r = lintSong(song(), good(), project);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.judgement).toEqual(['song-register-bands', 'song-fatigue']);
  });

  it('flags peaks, clipping and a peak-limited level', () => {
    const r = lintSong(song(), good({ delivered: { integratedLufs: -25, truePeakDb: -0.5, clippedSamples: 3, peakLimited: true } }), project);
    expect(r.errors.map(f => f.rule)).toEqual(['song-true-peak', 'song-no-clipping']);
    expect(ids(r)).toContain('song-loudness-target');
  });

  it('flags a flat long song, a jumpy seam, a short exploration loop and heavy low end', () => {
    const s = song({ loop: true, tags: ['exploration'] });
    const r = lintSong(s, good({ durationSec: 40, loudnessRangeLu: 1, seamDb: 6, lowShare: 0.7 }), project);
    expect(ids(r)).toEqual(expect.arrayContaining(['song-loop-seam', 'song-loop-length', 'song-low-end']));
    const flat = lintSong(song(), good({ loudnessRangeLu: 1 }), project);
    expect(ids(flat)).toContain('song-loudness-range');
  });

  it('points at patterns that fall below E1', () => {
    const s = song({ patterns: { 'pad-a': { bars: 2, bass: { progression: 'a', octave: 0 } }, 'hat-a': { bars: 1, steps: 'x' } } });
    expect(lintSong(s, good(), project).warnings).toContainEqual(expect.objectContaining({ rule: 'song-register', pointer: '/patterns/pad-a' }));
  });

  it('points at unused tracks and patterns', () => {
    const s = song({ patterns: { 'pad-a': { bars: 2, chords: { progression: 'a' } }, 'hat-a': { bars: 1, steps: 'x' }, spare: { bars: 1, steps: 'x' } }, sections: { a: { bars: 2, play: { pad: 'pad-a' } } } });
    const r = lintSong(s, good(), project);
    expect(r.warnings.filter(f => f.rule === 'song-unused').map(f => f.pointer).sort()).toEqual(['/patterns/hat-a', '/patterns/spare', '/tracks/hat']);
  });
});
