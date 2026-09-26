import { describe, expect, it } from 'vitest';
import { parseChord, voiceLead, chordTones } from '../../runtime/engine/chords.js';

describe('chord symbols', () => {
  it.each([
    ['C', 0, [0, 4, 7]],
    ['Am', 9, [0, 3, 7]],
    ['Dm9', 2, [0, 3, 7, 10, 14]],
    ['Bbmaj7', 10, [0, 4, 7, 11]],
    ['F#m7b5', 6, [0, 3, 6, 10]],
    ['C6/9', 0, [0, 4, 7, 9, 14]],
    ['Gsus4', 7, [0, 5, 7]],
    ['Esus2', 4, [0, 2, 7]],
    ['Ebadd9', 3, [0, 4, 7, 14]],
    ['G7', 7, [0, 4, 7, 10]],
    ['Bdim', 11, [0, 3, 6]],
    ['Caug', 0, [0, 4, 8]],
    ['Fmaj7#11', 5, [0, 4, 7, 11, 18]],
    ['Am11', 9, [0, 3, 7, 10, 14, 17]],
    ['Dmaj9', 2, [0, 4, 7, 11, 14]],
    ['C5', 0, [0, 7]],
  ])('%s', (sym, root, intervals) => {
    const c = parseChord(sym);
    expect(c.root).toBe(root);
    expect(c.intervals).toEqual(intervals);
  });

  it('reads a slash bass', () => {
    expect(parseChord('C/E')).toMatchObject({ root: 0, intervals: [0, 4, 7], bass: 4 });
  });

  it('rejects nonsense with a readable message', () => {
    expect(() => parseChord('Hmaj7')).toThrow(/chord/);
    expect(() => parseChord('Cwobble')).toThrow(/quality/);
  });
});

describe('voice leading', () => {
  it('places the first chord around the requested octave', () => {
    const [v] = voiceLead([parseChord('C')], { octave: 4 });
    expect(v).toEqual([60, 64, 67]);
  });

  it('moves each chord by the smallest total distance', () => {
    const [a, b] = voiceLead([parseChord('C'), parseChord('F')], { octave: 4 });
    expect(a).toEqual([60, 64, 67]);
    // C E G -> C F A (second inversion of F) moves 0+1+2 = 3 semitones
    expect(b).toEqual([60, 65, 69]);
  });

  it('keeps voicings inside a two-octave window around the target', () => {
    const chords = ['Dm9', 'G7', 'Cmaj7', 'Am7', 'Dm9', 'G7', 'Cmaj7', 'Am7'].map(parseChord);
    for (const v of voiceLead(chords, { octave: 4 })) {
      for (const n of v) { expect(n).toBeGreaterThanOrEqual(48); expect(n).toBeLessThanOrEqual(84); }
    }
  });

  it('spread voicing drops the root an octave below the rest', () => {
    const [v] = voiceLead([parseChord('C')], { octave: 4, voicing: 'spread' });
    expect(v[0]).toBe(48);
    expect(v.slice(1).every(n => n >= 60)).toBe(true);
  });

  it('chordTones lists pitch classes for arps and bass', () => {
    expect(chordTones(parseChord('Am7'))).toEqual([9, 0, 4, 7]);
  });
});
