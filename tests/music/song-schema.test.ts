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

  it('accepts mixed tuple and strict object notes without adding expression defaults', () => {
    const notes = [[0, 'C4', 1], { at: 1, note: 'D4', beats: 2, vel: 0.7, expression: { pitch: [[0, -2], [0.25, 0, 'linear']], brightness: [[0, -1], [2, 0.5, 'step']] } }];
    const r = parseSong(songInput({ tracks: { pad: { instrument: 'pad', velocityInput: 'keyTouch2' }, hat: { instrument: 'hat' } }, patterns: { 'pad-a': { bars: 2, notes }, 'hat-a': { bars: 1, steps: 'x' } } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.song.patterns['pad-a'].notes).toEqual(notes);
    expect(r.song.tracks.pad.velocityInput).toBe('keyTouch2');
    expect(r.song.tracks.hat).not.toHaveProperty('velocityInput');
  });

  it('accepts an object note without velocity or expression', () => {
    const r = parseSong(songInput({ patterns: { 'pad-a': { bars: 2, notes: [{ at: 0, note: 'C4', beats: 1 }] }, 'hat-a': { bars: 1, steps: 'x' } } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.song.patterns['pad-a'].notes?.[0]).toEqual({ at: 0, note: 'C4', beats: 1 });
  });

  it('checks object note positions and refuses expression on patch-duration gates', () => {
    const invalid = (note: unknown, gate?: string) => issues(songInput({ patterns: { 'pad-a': { bars: 1, notes: [note], ...(gate ? { gate } : {}) }, 'hat-a': { bars: 1, steps: 'x' } } }));
    expect(invalid({ at: 4, note: 'C4', beats: 1 })[0]).toMatchObject({ pointer: '/patterns/pad-a/notes/0/at', message: expect.stringMatching(/past the pattern/) });
    expect(invalid({ at: 0, note: 'C4', beats: 1, expression: { pitch: [[0, 0]] } }, 'patch')[0]).toMatchObject({ pointer: '/patterns/pad-a/notes/0/expression', message: expect.stringMatching(/held gate/) });
    expect(invalid({ at: 0, note: 'C4', beats: 1 }, 'patch')).toEqual([]);
  });

  it.each([
    ['empty expression', {}, 'expression'],
    ['empty curve', { pitch: [] }, 'expression/pitch'],
    ['too many points', { pitch: Array.from({ length: 65 }, (_, i) => [i / 64, 0]) }, 'expression/pitch'],
    ['nonzero start', { pitch: [[0.1, 0]] }, 'expression/pitch/0/0'],
    ['negative offset', { pitch: [[-0.1, 0]] }, 'expression/pitch/0/0'],
    ['duplicate times', { pitch: [[0, 0], [0, 1]] }, 'expression/pitch/1/0'],
    ['decreasing times', { pitch: [[0, 0], [0.5, 1], [0.25, 2]] }, 'expression/pitch/2/0'],
    ['past authored length', { pitch: [[0, 0], [1.01, 1]] }, 'expression/pitch/1/0'],
    ['nonfinite time', { pitch: [[0, 0], [Infinity, 1]] }, 'expression/pitch/1/0'],
    ['nonfinite value', { pitch: [[0, NaN]] }, 'expression/pitch/0/1'],
    ['high pitch', { pitch: [[0, 24.01]] }, 'expression/pitch/0/1'],
    ['low pitch', { pitch: [[0, -24.01]] }, 'expression/pitch/0/1'],
    ['high brightness', { brightness: [[0, 4.01]] }, 'expression/brightness/0/1'],
    ['low brightness', { brightness: [[0, -4.01]] }, 'expression/brightness/0/1'],
    ['unknown arrival curve', { pitch: [[0, 0, 'ease']] }, 'expression/pitch/0/2'],
    ['extra point value', { pitch: [[0, 0, 'linear', 1]] }, 'expression/pitch/0'],
    ['unknown expression field', { gain: [[0, 0]] }, 'expression'],
  ])('rejects %s at the affected expression field', (_label, expression, field) => {
    const r = issues(songInput({ patterns: { 'pad-a': { bars: 1, notes: [{ at: 0, note: 'C4', beats: 1, expression }] }, 'hat-a': { bars: 1, steps: 'x' } } }));
    expect(r).toContainEqual(expect.objectContaining({ pointer: `/patterns/pad-a/notes/0/${field}` }));
  });

  it.each(['Touch', 'touch-value', 'touch_value', '1touch', ''])('rejects velocityInput %j outside the runtime input naming grammar', velocityInput => {
    expect(issues(songInput({ tracks: { pad: { instrument: 'pad', velocityInput }, hat: { instrument: 'hat' } } }))[0]).toMatchObject({ pointer: '/tracks/pad/velocityInput' });
  });

  it('keeps object notes strict and accepts curve unit boundaries', () => {
    const note = { at: 0, note: 'C4', beats: 1, expression: { pitch: [[0, -24], [1, 24]], brightness: [[0, -4], [1, 4]] } };
    const input = (n: unknown) => songInput({ patterns: { 'pad-a': { bars: 1, notes: [n] }, 'hat-a': { bars: 1, steps: 'x' } } });
    expect(parseSong(input(note)).ok).toBe(true);
    expect(issues(input({ ...note, velocity: 0.5 }))[0]).toMatchObject({ pointer: '/patterns/pad-a/notes/0' });
  });
});
