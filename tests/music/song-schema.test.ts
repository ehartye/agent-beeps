import { describe, expect, it } from 'vitest';
import { parseSong } from '../../src/schema/song.ts';
import { songInput } from '../helpers/songs.ts';

const issues = (input: unknown) => { const r = parseSong(input); return r.ok ? [] : r.issues; };

describe('beeps/song@1', () => {
  it('parses a song and fills defaults', () => {
    const r = parseSong(songInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.song.meter).toBe(4);
    expect(r.song.swing).toBe(0);
    expect(r.song.loop).toBe(false);
    expect(r.song.tracks.pad.gainDb).toBe(0);
    expect(r.song.patterns['pad-a'].chords?.voicing).toBe('lead');
  });

  it('points at a pattern that names an unknown progression', () => {
    const bad = songInput({ patterns: { 'pad-a': { bars: 2, chords: { progression: 'zz' } }, 'hat-a': { bars: 1, steps: 'x...' } } });
    expect(issues(bad)[0]).toMatchObject({ pointer: '/patterns/pad-a/chords/progression' });
  });

  it('points at a section that plays an unknown pattern or track', () => {
    expect(issues(songInput({ sections: { a: { bars: 2, play: { pad: 'nope' } } } }))[0]).toMatchObject({ pointer: '/sections/a/play/pad' });
    expect(issues(songInput({ sections: { a: { bars: 2, play: { drums: 'hat-a' } } } }))[0]).toMatchObject({ pointer: '/sections/a/play/drums' });
  });

  it('points at a form entry naming an unknown section', () => {
    expect(issues(songInput({ form: ['a', 'b'] }))[0]).toMatchObject({ pointer: '/form/1' });
  });

  it('needs exactly one kind of content per pattern', () => {
    const two = songInput({ patterns: { 'pad-a': { bars: 2, steps: 'x...', notes: [[0, 'C4', 1]] }, 'hat-a': { bars: 1, steps: 'x...' } } });
    expect(issues(two)[0].message).toMatch(/exactly one of/);
  });

  it('rejects unknown step characters and bad chord symbols with a hint', () => {
    const steps = issues(songInput({ patterns: { 'pad-a': { bars: 2, chords: { progression: 'a' } }, 'hat-a': { bars: 1, steps: 'x.y.' } } }));
    expect(steps[0].pointer).toBe('/patterns/hat-a/steps');
    const chord = issues(songInput({ progressions: { a: [['Cwobble', 4]] } }));
    expect(chord[0]).toMatchObject({ pointer: '/progressions/a/0/0' });
    expect(chord[0].message).toMatch(/quality/);
  });

  it('accepts an instrument by name and a note number is refused', () => {
    expect(parseSong(songInput({ tracks: { pad: { instrument: 'glass-pad' }, hat: { instrument: 'hat' } } })).ok).toBe(true);
    const r = issues(songInput({ patterns: { 'pad-a': { bars: 2, notes: [[0, 60, 1]] }, 'hat-a': { bars: 1, steps: 'x...' } } }));
    expect(r[0].pointer).toBe('/patterns/pad-a/notes/0/1');
  });
});
