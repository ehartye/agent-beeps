import { describe, expect, it } from 'vitest';
import { songRenderKey } from '../../src/render/song-pipeline.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { patch } from '../helpers/patches.ts';
import { HAT, PAD, song } from '../helpers/songs.ts';

const s = song({ loop: true, patterns: { 'pad-a': { bars: 2, chords: { progression: 'a', octave: 4 } }, 'hat-a': { bars: 1, steps: 'x?x?x?x?x?x?x?x?' } } });
const instruments = { pad: patch(PAD), hat: patch(HAT) };
const target = defaultProject().musicLoudness;

describe('song render key', () => {
  it('is unchanged for a full render, so approved mixes keep their cached audio', () => {
    // Recorded before solo-by-filter existed; a change here re-renders every approved song.
    expect(songRenderKey(s, instruments, { target })).toBe('e8159013aad6f83fc8f318f7f965ea57c8bb8109f83822713ba47b15b6fa357e');
  });

  it('gives solos their own key, whatever the order of the tracks', () => {
    const full = songRenderKey(s, instruments, { target, fixedTrim: -3 });
    const solo = songRenderKey(s, instruments, { target, fixedTrim: -3, only: ['pad', 'hat'] });
    expect(solo).not.toBe(full);
    expect(songRenderKey(s, instruments, { target, fixedTrim: -3, only: ['hat', 'pad'] })).toBe(solo);
    expect(songRenderKey(s, instruments, { target, fixedTrim: -3, only: ['hat'] })).not.toBe(solo);
  });
});
