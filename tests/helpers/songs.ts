import { parseSong, type Song } from '../../src/schema/song.ts';

export const PAD = {
  schema: 'beeps/patch@1', name: 'pad', family: 'music', duration: 1,
  layers: [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'C4' }, amp: { attack: 0.2, decay: 0.5, sustain: 0.7, release: 0.5 }, filter: { type: 'lowpass', cutoff: 2000, resonanceDb: 0 } }],
};
export const HAT = {
  schema: 'beeps/patch@1', name: 'hat', family: 'music', duration: 0.05,
  layers: [{ source: { type: 'noise', color: 'white' }, amp: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 }, filter: { type: 'highpass', cutoff: 7000, resonanceDb: 0 } }],
};

export const songInput = (over: Record<string, unknown> = {}) => ({
  schema: 'beeps/song@1', name: 'test-song', bpm: 120,
  progressions: { a: [['C', 4], ['F', 4]] },
  tracks: { pad: { instrument: PAD }, hat: { instrument: HAT, gainDb: -6 } },
  patterns: {
    'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 } },
    'hat-a': { bars: 1, steps: 'x.x.x.x.x.x.x.x.' },
  },
  sections: { a: { bars: 2, play: { pad: 'pad-a', hat: 'hat-a' } } },
  form: ['a'],
  ...over,
});

export function song(over: Record<string, unknown> = {}): Song {
  const r = parseSong(songInput(over));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.song;
}
