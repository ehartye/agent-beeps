import { describe, expect, it } from 'vitest';
import { noteToHz, snapToScale, hzToMidi, midiToHz, SCALES } from '../../runtime/engine/notes.js';

describe('notes', () => {
  it('converts note names and passes numbers through', () => {
    expect(noteToHz('A4')).toBeCloseTo(440);
    expect(noteToHz('C4')).toBeCloseTo(261.626, 2);
    expect(noteToHz('Bb3')).toBeCloseTo(233.082, 2);
    expect(noteToHz('F#5')).toBeCloseTo(739.989, 2);
    expect(noteToHz(1000)).toBe(1000);
    expect(() => noteToHz('H2')).toThrow(/note/);
  });
  it('round-trips midi', () => {
    expect(hzToMidi(440)).toBeCloseTo(69);
    expect(midiToHz(60)).toBeCloseTo(261.626, 2);
  });
  it('snaps to the nearest in-scale pitch', () => {
    const scale = { root: 'C', mode: 'majorPentatonic' } as const;
    expect(snapToScale(450, scale)).toBeCloseTo(440);
    expect(snapToScale(466.16, scale)).toBeCloseTo(440);
    expect(snapToScale(261.6, scale)).toBeCloseTo(261.626, 2);
    expect(snapToScale(1000, { root: 'C', mode: 'chromatic' } as const)).toBeCloseTo(987.77, 1);
    expect(SCALES.majorPentatonic).toEqual([0, 2, 4, 7, 9]);
  });
});
