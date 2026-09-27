import { describe, expect, it } from 'vitest';
import { soloSong } from '../../src/music.ts';
import { song } from '../helpers/songs.ts';

describe('soloSong', () => {
  const s = song({ sections: { a: { bars: 2, play: { pad: 'pad-a', hat: 'hat-a' } }, b: { bars: 1, play: { hat: 'hat-a' } } }, form: ['a', 'b', 'a'] });

  it('keeps only the named tracks playing', () => {
    const solo = soloSong(s, { only: ['pad'] });
    expect(solo.sections.a.play).toEqual({ pad: 'pad-a' });
    expect(solo.sections.b.play).toEqual({});
    expect(solo.form).toEqual(['a', 'b', 'a']);
    expect(solo.loop).toBe(false);
  });

  it('keeps only the named sections, in form order', () => {
    expect(soloSong(s, { sections: ['b'] }).form).toEqual(['b']);
  });

  it('refuses unknown tracks and sections', () => {
    expect(() => soloSong(s, { only: ['bass'] })).toThrow(/no track "bass"/);
    expect(() => soloSong(s, { sections: ['z'] })).toThrow(/no section "z"/);
  });
});
