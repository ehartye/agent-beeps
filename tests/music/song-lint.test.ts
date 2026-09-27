import { describe, expect, it } from 'vitest';
import { lintSong, registerOverlaps } from '../../src/song-lint.ts';
import { defaultProject } from '../../src/schema/project.ts';
import type { SongFeatures } from '../../src/measure/song.ts';
import { HAT, PAD, song } from '../helpers/songs.ts';
import { patch } from '../helpers/patches.ts';

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

  it('counts an instrument layer an octave below its root as sounding there', () => {
    const lowPad = patch({ ...PAD, layers: [PAD.layers[0], { ...PAD.layers[0], source: { type: 'osc', wave: 'sine', pitch: 'C3' } }] });
    const s = song({ patterns: { 'pad-a': { bars: 2, bass: { progression: 'a', octave: 1 } }, 'hat-a': { bars: 1, steps: 'x' } } });
    // octave 1 roots (C1 = MIDI 24) are already low; the C3 layer under a C4 root sounds an octave lower still
    const plain = lintSong(s, good(), project, { pad: patch(PAD), hat: patch(HAT) });
    const layered = lintSong(s, good(), project, { pad: lowPad, hat: patch(HAT) });
    expect(plain.warnings.find(f => f.rule === 'song-register')?.message).toMatch(/33 Hz/);
    expect(layered.warnings.find(f => f.rule === 'song-register')?.message).toMatch(/16 Hz/);
    expect(layered.warnings.find(f => f.rule === 'song-register')?.message).toMatch(/layer/);
  });

  it('backs the register judgement with the overlapping parts of each section', () => {
    const s = song({ patterns: { 'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 } }, 'hat-a': { bars: 1, notes: [[0, 'E4', 4]] } } });
    const r = lintSong(s, good(), project, { pad: patch(PAD), hat: patch(PAD) });
    const check = r.judgementChecks.find(j => j.rule === 'song-register-bands')!;
    expect(check.data).toEqual([{ section: 'a', overlaps: ['pad C4-A4 and hat E4 share a band'] }]);
  });

  it('points at unused tracks and patterns', () => {
    const s = song({ patterns: { 'pad-a': { bars: 2, chords: { progression: 'a' } }, 'hat-a': { bars: 1, steps: 'x' }, spare: { bars: 1, steps: 'x' } }, sections: { a: { bars: 2, play: { pad: 'pad-a' } } } });
    const r = lintSong(s, good(), project);
    expect(r.warnings.filter(f => f.rule === 'song-unused').map(f => f.pointer).sort()).toEqual(['/patterns/hat-a', '/patterns/spare', '/tracks/hat']);
  });
});

describe('concurrent register evidence', () => {
  it('leaves call-and-response parts unflagged, including touching note boundaries', () => {
    const s = song({ patterns: {
      'pad-a': { bars: 2, notes: [[0, 'C4', 2], [4, 'G4', 2]] },
      'hat-a': { bars: 2, notes: [[2, 'C4', 2], [6, 'G4', 2]] },
    } });
    expect(registerOverlaps(s, {})).toEqual([]);
  });

  it('does not combine sequential pitches into a simultaneous chord band', () => {
    const s = song({ patterns: {
      'pad-a': { bars: 2, notes: [[0, 'C4', 4], [4, 'C5', 4]] },
      'hat-a': { bars: 2, notes: [[0, 'G4', 8]] },
    } });
    expect(registerOverlaps(s, {})).toEqual([]);
  });

  it('treats touching beat boundaries as nonoverlapping at fractional-second tempos', () => {
    const s = song({ bpm: 41, patterns: {
      'pad-a': { bars: 2, notes: [[0.25, 'C4', 3]] },
      'hat-a': { bars: 2, notes: [[3.25, 'C4', 0.25]] },
    } });
    expect(registerOverlaps(s, {})).toEqual([]);
  });

  it('retains layer offsets when matching concurrent notes', () => {
    const s = song({ patterns: {
      'pad-a': { bars: 2, notes: [[0, 'C5', 8]] },
      'hat-a': { bars: 2, notes: [[0, 'C4', 8]] },
    } });
    expect(registerOverlaps(s, { pad: { low: -12, high: 0 } })).toEqual([
      { section: 'a', overlaps: ['pad C4-C5 and hat C4 share a band'] },
    ]);
  });

  it('checks later occurrences of a section when a seeded hit was absent the first time', () => {
    const s = song({ seed: 1, patterns: {
      'pad-a': { bars: 1, notes: [[0, 'C4', 4]] },
      'hat-a': { bars: 1, steps: '?...............', note: 'C4', gate: 1 },
    }, sections: { a: { bars: 1, play: { pad: 'pad-a', hat: 'hat-a' } } }, form: ['a', 'a'] });
    expect(registerOverlaps(s, {})).toEqual([
      { section: 'a', overlaps: ['pad C4 and hat C4 share a band'] },
    ]);
  });

  it('includes a held note that humanization carries into the next section', () => {
    const s = song({ seed: 2, tracks: { pad: { instrument: PAD, humanize: 1 }, hat: { instrument: PAD } },
      patterns: { p: { bars: 1, notes: [[0, 'C4', 4]] }, h: { bars: 1, notes: [[0, 'C4', 1]] } },
      sections: { a: { bars: 1, play: { pad: 'p' } }, b: { bars: 1, play: { hat: 'h' } } }, form: ['a', 'b'],
    });
    expect(registerOverlaps(s, {})).toEqual([
      { section: 'b', overlaps: ['pad C4 and hat C4 share a band'] },
    ]);
  });

  it('does not invent durations for pitched one-shots', () => {
    const s = song({ patterns: {
      'pad-a': { bars: 2, notes: [[0, 'C4', 8]] },
      'hat-a': { bars: 2, steps: 'x', note: 'C4' },
    } });
    expect(registerOverlaps(s, {})).toEqual([]);
  });
});

describe('register evidence for unpitched instruments', () => {
  const held = { patterns: {
    'pad-a': { bars: 2, notes: [[0, 'D4', 8]] },
    'hat-a': { bars: 2, notes: [[0, 'D4', 8]] },
  } };

  it('ignores trigger notes of a track whose instrument has no pitched layer', () => {
    expect(registerOverlaps(song(held), { pad: { low: 0, high: 0 }, hat: null })).toEqual([]);
    const r = lintSong(song(held), good(), project, { pad: patch(PAD), hat: patch(HAT) });
    expect(r.judgementChecks.find(j => j.rule === 'song-register-bands')!.data).toBeUndefined();
  });

  it('still flags a mixed noise and pitched instrument by its pitched layers', () => {
    const breathy = patch({ ...PAD, layers: [HAT.layers[0], PAD.layers[0]] });
    const r = lintSong(song(held), good(), project, { pad: patch(PAD), hat: breathy });
    expect(r.judgementChecks.find(j => j.rule === 'song-register-bands')!.data).toEqual([{ section: 'a', overlaps: ['pad D4 and hat D4 share a band'] }]);
  });

  it('keeps treating a track as pitched when its instrument is unknown', () => {
    expect(registerOverlaps(song(held), {})).toEqual([{ section: 'a', overlaps: ['pad D4 and hat D4 share a band'] }]);
  });
});
