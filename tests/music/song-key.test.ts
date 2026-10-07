import { describe, expect, it } from 'vitest';
import { renderKey } from '../../src/hash.ts';
import { SONG_PIPELINE_VERSION, songRenderKey } from '../../src/render/song-pipeline.ts';
import { parseSong } from '../../src/schema/song.ts';
import { parsePatch } from '../../src/schema/patch.ts';

// Fixtures inlined, so edits to the shared test helpers never move the pinned key.
const PAD = {
  schema: 'beeps/patch@1', name: 'pad', family: 'music', duration: 1,
  layers: [{ source: { type: 'osc', wave: 'sawtooth', pitch: 'C4' }, amp: { attack: 0.2, decay: 0.5, sustain: 0.7, release: 0.5 }, filter: { type: 'lowpass', cutoff: 2000, resonanceDb: 0 } }],
};
const HAT = {
  schema: 'beeps/patch@1', name: 'hat', family: 'music', duration: 0.05,
  layers: [{ source: { type: 'noise', color: 'white' }, amp: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 }, filter: { type: 'highpass', cutoff: 7000, resonanceDb: 0 } }],
};
const parsedSong = parseSong({
  schema: 'beeps/song@1', name: 'test-song', bpm: 120, loop: true,
  progressions: { a: [['C', 4], ['F', 4]] },
  tracks: { pad: { instrument: PAD }, hat: { instrument: HAT, gainDb: -6 } },
  patterns: {
    'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 } },
    'hat-a': { bars: 1, steps: 'x?x?x?x?x?x?x?x?' },
  },
  sections: { a: { bars: 2, play: { pad: 'pad-a', hat: 'hat-a' } } },
  form: ['a'],
});
if (!parsedSong.ok) throw new Error(JSON.stringify(parsedSong.issues));
const s = parsedSong.song;
const patchOf = (x: unknown) => { const r = parsePatch(x); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.patch; };
const instruments = { pad: patchOf(PAD), hat: patchOf(HAT) };
const target = -20;

describe('song render key', () => {
  it('is unchanged for a full render, so approved mixes keep their cached audio', () => {
    // The formula full renders used before solo-by-filter existed.
    expect(songRenderKey(s, instruments, { target })).toBe(renderKey({ song: s, instruments }, { kind: 'song', target, pipeline: SONG_PIPELINE_VERSION }));
    expect(songRenderKey(s, instruments, { target, fixedTrim: -3 })).toBe(renderKey({ song: s, instruments }, { kind: 'song', target, pipeline: SONG_PIPELINE_VERSION, fixedTrim: -3 }));
    // A change here re-renders every approved song. Recorded before solo-by-filter existed (engine 1:
    // e8159013...357e); re-recorded for engine 2, whose fixed-order sums make renders bit-exact.
    expect(songRenderKey(s, instruments, { target })).toBe('84acee7d13b1dee4cdde21e249d78da147ba90bc98dc99d340e9384ff6a1c219');
  });

  it('treats an empty track list as no filter', () => {
    expect(songRenderKey(s, instruments, { target, only: [] })).toBe(songRenderKey(s, instruments, { target }));
  });

  it('gives solos their own key, whatever the order of the tracks', () => {
    const full = songRenderKey(s, instruments, { target, fixedTrim: -3 });
    const solo = songRenderKey(s, instruments, { target, fixedTrim: -3, only: ['pad', 'hat'] });
    expect(solo).not.toBe(full);
    expect(songRenderKey(s, instruments, { target, fixedTrim: -3, only: ['hat', 'pad'] })).toBe(solo);
    expect(songRenderKey(s, instruments, { target, fixedTrim: -3, only: ['hat'] })).not.toBe(solo);
  });
});
