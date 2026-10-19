import { describe, expect, it } from 'vitest';
import { compileSong } from '../../runtime/engine/sequence.js';
import { song } from '../helpers/songs.ts';

const of = (c: ReturnType<typeof compileSong>, track: string) => c.events.filter(e => e.track === track);

describe('compileSong', () => {
  it('lays out sections in form order with lengths in seconds', () => {
    const c = compileSong(song({ sections: { a: { bars: 2, play: { pad: 'pad-a' } }, b: { bars: 1, play: {} } }, form: ['a', 'b', 'a'] }));
    expect(c.sections.map(s => [s.name, s.start, s.end])).toEqual([['a', 0, 4], ['b', 4, 6], ['a', 6, 10]]);
    expect(c.length).toBe(10);
  });

  it('holds voice-led chords for their progression length', () => {
    const c = compileSong(song());
    const pad = of(c, 'pad');
    expect(pad.filter(e => e.time === 0).map(e => e.midi)).toEqual([60, 64, 67]);
    expect(pad.filter(e => e.time === 2).map(e => e.midi)).toEqual([60, 65, 69]);
    expect(pad[0].dur).toBe(2);
  });

  it('plays steps at sixteenths with patch-length gates and loops to fill the section', () => {
    const hats = of(compileSong(song()), 'hat');
    expect(hats).toHaveLength(16); // 8 hits per bar, 2 bars
    expect(hats[1].time).toBeCloseTo(0.25);
    expect(hats[0].dur).toBeNull();
    expect(hats[0].midi).toBeNull();
    expect(hats[0].vel).toBeCloseTo(0.7);
  });

  it('extends a step with _ and scales velocity by accent', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 1, steps: 'X__.o...........', note: 'C3', gate: 1 }, 'hat-a': { bars: 1, steps: 'x' } } }));
    const [a, b] = of(c, 'pad');
    expect(a).toMatchObject({ vel: 1, midi: 48 });
    expect(a.dur).toBeCloseTo(0.375);
    expect(b.vel).toBeCloseTo(0.4);
  });

  it('swings off-beat sixteenths', () => {
    const hats = of(compileSong(song({ swing: 0.5, patterns: { 'pad-a': { bars: 1, notes: [[0, 'C4', 1]] }, 'hat-a': { bars: 1, steps: 'xxxx' } } })), 'hat');
    expect(hats[1].time).toBeCloseTo(0.125 + 0.0625);
    expect(hats[2].time).toBeCloseTo(0.25);
  });

  it('arpeggiates chord tones up across octaves at the given rate', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 2, arp: { progression: 'a', rate: 2, octaves: 2, shape: 'up' } }, 'hat-a': { bars: 1, steps: 'x' } } }));
    const arp = of(c, 'pad');
    expect(arp.slice(0, 6).map(e => e.midi)).toEqual([60, 64, 67, 72, 76, 79]);
    expect(arp[1].time).toBeCloseTo(0.25);
    expect(arp[0].dur).toBeCloseTo(0.25 * 0.9);
  });

  it('plays bass roots (or slash bass) on a rhythm, cycling chord tones', () => {
    const c = compileSong(song({
      progressions: { a: [['C/E', 4], ['G', 4]] },
      patterns: { 'pad-a': { bars: 2, bass: { progression: 'a', octave: 2, rhythm: 'x.......x.......', tones: [0, 2] } }, 'hat-a': { bars: 1, steps: 'x' } },
    }));
    expect(of(c, 'pad').map(e => e.midi)).toEqual([40, 43, 43, 50]);
  });

  it('applies transposition and plays explicit notes', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 1, transpose: 12, notes: [[1, 'A4', 2, 0.5]] }, 'hat-a': { bars: 1, steps: 'x' } } }));
    expect(of(c, 'pad')[0]).toMatchObject({ time: 0.5, midi: 81, vel: 0.5, dur: 1 });
  });

  it('compiles mixed tuple and object notes while preserving legacy event fields', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 2, transpose: 12, vel: 0.5, notes: [[0, 'C4', 1], { at: 1, note: 'D4', beats: 2, vel: 0.8 }, { at: 3, note: 'E4', beats: 2, expression: { pitch: [[0, -2], [0.5, 0, 'linear']], brightness: [[0, -1], [2, 1, 'step']] } }] }, 'hat-a': { bars: 1, steps: 'x' } } }));
    const notes = of(c, 'pad');
    expect(notes[0]).toEqual({ track: 'pad', time: 0, dur: 0.5, midi: 72, vel: 0.5, pan: 0, pattern: 'pad-a' });
    expect(notes[1]).toEqual({ track: 'pad', time: 0.5, dur: 1, midi: 74, vel: 0.4, pan: 0, pattern: 'pad-a' });
    expect(notes[2]).toEqual({ track: 'pad', time: 1.5, dur: 1, midi: 76, vel: 0.5, pan: 0, pattern: 'pad-a', expression: { pitch: [[0, -2], [0.25, 0, 'linear']], brightness: [[0, -1], [1, 1, 'step']] } });
  });

  it('clips gestures at the section boundary after swing and humanization', () => {
    for (const humanize of [0, 1]) {
      const c = compileSong(song({ swing: .5, tracks: { pad: { instrument: 'x', humanize } },
        patterns: { tail: { bars: 1, notes: [{ at: 3.75, note: 'C4', beats: 1, expression: { pitch: [[0, 0], [1, 12]] } }] } },
        sections: { a: { bars: 1, play: { pad: 'tail' } } }, form: ['a'] }));
      const e = c.events[0];
      expect(e.time + e.dur!).toBeCloseTo(2, 10);
      expect(e.expression!.pitch!.at(-1)![0]).toBeCloseTo(e.dur!, 10);
      expect(e.expression!.pitch!.at(-1)![1]).toBeCloseTo(e.dur! * 24, 10);
    }
  });

  it('discards expressive onsets shifted completely beyond their section', () => {
    for (let seed = 1; seed <= 24; seed++) {
      const c = compileSong(song({ seed, tracks: { pad: { instrument: 'x', humanize: 1 } },
        patterns: { tail: { bars: 1, notes: [{ at: 3.999, note: 'C4', beats: 1, expression: { pitch: [[0, 0], [1, 12]] } }] } },
        sections: { a: { bars: 1, play: { pad: 'tail' } } }, form: ['a'] }));
      for (const e of c.events) expect(e.time + e.dur!).toBeLessThanOrEqual(2);
    }
  });

  it('clips expression to the held gate using the arriving point curve', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 2, gate: 0.5, notes: [{ at: 0, note: 'C4', beats: 4, expression: { pitch: [[0, -12], [4, 12]], brightness: [[0, -2], [4, 2, 'step']] } }, { at: 4, note: 'C4', beats: 4, expression: { pitch: [[0, 0], [1, 4, 'step'], [3, 12, 'linear']] } }] }, 'hat-a': { bars: 1, steps: 'x' } } }));
    const notes = of(c, 'pad');
    expect(notes[0].dur).toBe(1);
    expect(notes[0].expression).toEqual({ pitch: [[0, -12], [1, 0]], brightness: [[0, -2], [1, -2, 'step']] });
    expect(notes[1].expression).toEqual({ pitch: [[0, 0], [0.5, 4, 'step'], [1, 8, 'linear']] });
  });

  it('keeps an exact-boundary step at non-binary tempos', () => {
    const c = compileSong(song({ bpm: 31, tracks: { pad: { instrument: 'x' } },
      patterns: { tail: { bars: 1, notes: [{ at: .25, note: 'C4', beats: 3.75, expression: { pitch: [[0, 0], [3.75, 12, 'step']] } }] } },
      sections: { a: { bars: 1, play: { pad: 'tail' } } }, form: ['a'] }));
    expect(c.events[0].expression!.pitch!.at(-1)![1]).toBe(12);
  });

  it('clips curves at section boundaries and preserves an exact boundary step', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 1, notes: [{ at: 3, note: 'C4', beats: 4, expression: { pitch: [[0, -4], [2, 4]], brightness: [[0, -1], [1, 1, 'step'], [4, 2]] } }] }, 'hat-a': { bars: 1, steps: 'x' } }, sections: { a: { bars: 1, play: { pad: 'pad-a' } } } }));
    expect(of(c, 'pad')[0]).toMatchObject({ dur: 0.5, expression: { pitch: [[0, -4], [0.5, 0]], brightness: [[0, -1], [0.5, 1, 'step']] } });
  });

  it('holds a completed curve through longer gates and repeats relative to each onset', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 1, gate: 2, notes: [{ at: 0, note: 'C4', beats: 1, expression: { pitch: [[0, -1], [1, 0]] } }] }, 'hat-a': { bars: 1, steps: 'x' } } }));
    const notes = of(c, 'pad');
    expect(notes.map(e => [e.time, e.dur, e.expression])).toEqual([[0, 1, { pitch: [[0, -1], [0.5, 0]] }], [2, 1, { pitch: [[0, -1], [0.5, 0]] }]]);
    expect(notes[0].expression).not.toBe(notes[1].expression);
  });

  it('keeps expression relative to swung and humanized onsets without consuming random draws', () => {
    const notes = [[0.25, 'C4', 1, 0.7], [1, 'D4', 1, 0.5]];
    const over = { seed: 17, swing: 0.5, tracks: { pad: { instrument: 'x', humanize: 1 }, hat: { instrument: 'y' } }, patterns: { 'pad-a': { bars: 1, notes }, 'hat-a': { bars: 1, steps: '?x' } } };
    const plain = compileSong(song(over));
    const expression = { pitch: [[0, -2], [1, 0]] };
    const expressiveSong = song({ ...over, patterns: { ...over.patterns, 'pad-a': { bars: 1, notes: notes.map(([at, note, beats, vel]) => ({ at, note, beats, vel, expression })) } } });
    const expressive = compileSong(expressiveSong);
    expect(expressive).toEqual(compileSong(expressiveSong));
    expect(expressive.events.map(({ expression: _expression, ...event }) => event)).toEqual(plain.events);
    expect(of(expressive, 'pad').every(e => JSON.stringify(e.expression) === JSON.stringify({ pitch: [[0, -2], [0.5, 0]] }))).toBe(true);
    expect(expressiveSong.patterns['pad-a'].notes?.[0]).toMatchObject({ expression });
  });

  it('clips held notes at the section end', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 1, notes: [[3, 'C4', 8]] }, 'hat-a': { bars: 1, steps: 'x' } }, sections: { a: { bars: 1, play: { pad: 'pad-a' } } } }));
    expect(of(c, 'pad')[0].dur).toBeCloseTo(0.5);
  });

  it('builds mix automation from sections', () => {
    const c = compileSong(song({ sections: { a: { bars: 2, play: {} }, b: { bars: 2, play: {}, mix: { pad: { gainDb: -12, cutoff: 800 } }, ramp: true } }, form: ['a', 'b'] }));
    expect(c.mix.pad).toEqual([{ time: 4, end: 8, gainDb: -12, cutoff: 800, ramp: true }]);
  });

  it('is deterministic under humanize', () => {
    const s = song({ tracks: { pad: { instrument: 'x', humanize: 1 }, hat: { instrument: 'y' } } });
    expect(compileSong(s)).toEqual(compileSong(s));
    const t = of(compileSong(s), 'pad').map(e => e.time);
    expect(t.some(x => x !== 0 && x !== 2)).toBe(true);
  });

  it('ramps over part of a section, at its start or its end', () => {
    const c = compileSong(song({ sections: { a: { bars: 4, play: {}, mix: { pad: { gainDb: -20 } }, ramp: { bars: 1, at: 'end' } }, b: { bars: 4, play: {}, mix: { pad: { gainDb: 0 } }, ramp: { bars: 2, at: 'start' } } }, form: ['a', 'b'] }));
    expect(c.mix.pad[0]).toMatchObject({ time: 6, end: 8, ramp: true });
    expect(c.mix.pad[1]).toMatchObject({ time: 8, end: 12, ramp: true });
  });

  it('carries pan and send moves in section mixes', () => {
    const c = compileSong(song({ sections: { a: { bars: 2, play: {}, mix: { pad: { pan: -0.5, sends: { reverb: -3 } } } } } }));
    expect(c.mix.pad[0]).toMatchObject({ pan: -0.5, sends: { reverb: -3 } });
  });

  it('leaves a slash bass out of chords and arps when slash is false (and out of arps by default)', () => {
    const base = { progressions: { a: [['C/E', 8]] }, sections: { a: { bars: 2, play: { pad: 'pad-a' } } } };
    const withSlash = of(compileSong(song({ ...base, patterns: { 'pad-a': { bars: 2, chords: { progression: 'a' } }, 'hat-a': { bars: 1, steps: 'x' } } })), 'pad');
    expect(withSlash.map(e => e.midi)).toContain(52);
    const noSlash = of(compileSong(song({ ...base, patterns: { 'pad-a': { bars: 2, chords: { progression: 'a', slash: false } }, 'hat-a': { bars: 1, steps: 'x' } } })), 'pad');
    expect(noSlash.map(e => e.midi)).toEqual([60, 64, 67]);
    const arp = of(compileSong(song({ ...base, patterns: { 'pad-a': { bars: 2, arp: { progression: 'a', rate: 1 } }, 'hat-a': { bars: 1, steps: 'x' } } })), 'pad');
    expect(Math.min(...arp.map(e => e.midi!))).toBe(60);
  });

  it('lets rhythm hits last hitBeats instead of one step', () => {
    const c = compileSong(song({ patterns: { 'pad-a': { bars: 1, steps: 'x...x_..', note: 'C3', gate: 1, hitBeats: 0.5 }, 'hat-a': { bars: 1, steps: 'x' } }, sections: { a: { bars: 1, play: { pad: 'pad-a' } } } }));
    // first hit 0.5 beat = 0.25 s; the held one is one step longer
    expect(of(c, 'pad').map(e => e.dur)).toEqual([0.25, expect.closeTo(0.375, 6), 0.25, expect.closeTo(0.375, 6)]);
  });

  it('plays ? steps about half the time, deterministically', () => {
    const s = song({ patterns: { 'pad-a': { bars: 16, steps: '????????????????' }, 'hat-a': { bars: 1, steps: 'x' } }, sections: { a: { bars: 16, play: { pad: 'pad-a' } } } });
    const n = of(compileSong(s), 'pad').length;
    expect(n).toBeGreaterThan(256 * 0.4);
    expect(n).toBeLessThan(256 * 0.6);
    expect(of(compileSong(s), 'pad').length).toBe(n);
  });

  it('swings one track without swinging the others', () => {
    const c = compileSong(song({ tracks: { pad: { instrument: 'x' }, hat: { instrument: 'y', swing: 0.5 } }, patterns: { 'pad-a': { bars: 1, steps: 'xxxx' }, 'hat-a': { bars: 1, steps: 'xxxx' } }, sections: { a: { bars: 1, play: { pad: 'pad-a', hat: 'hat-a' } } } }));
    expect(of(c, 'hat')[1].time).toBeCloseTo(0.1875);
    expect(of(c, 'pad')[1].time).toBeCloseTo(0.125);
  });

  it('restores a section-scoped mix when the section ends', () => {
    const c = compileSong(song({ tracks: { pad: { instrument: 'x', gainDb: -3 }, hat: { instrument: 'y' } }, sections: { a: { bars: 2, play: {}, mix: { pad: { gainDb: -20 } }, mixScope: 'section' }, b: { bars: 2, play: {} } }, form: ['a', 'b'] }));
    expect(c.mix.pad).toEqual([
      { time: 0, end: 0, gainDb: -20, ramp: false },
      { time: 4, end: 4, gainDb: -3, ramp: false },
    ]);
  });
});

