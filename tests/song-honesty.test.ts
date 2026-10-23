// Honest feedback, Phase 2c (0.22.0): a song says what the sequencer and the effects cut.
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateTrim } from '../src/render/layers.ts';
import { delayTailNotice } from '../src/patch-notices.ts';
import { patternTruncationNotices, songDelayNotices } from '../src/song-notices.ts';
import { song } from './helpers/songs.ts';
import { beeps, project } from './helpers/cli.ts';

describe('what a song cuts', () => {
  it('reports a pattern that runs past its section, with the notes it loses', () => {
    // pad-a is two bars (a chord each); a one-bar section plays only its first chord.
    const s = song({ sections: { a: { bars: 1, play: { pad: 'pad-a', hat: 'hat-a' } } } });
    const [n] = patternTruncationNotices(s);
    expect(n).toMatchObject({ code: 'N_PATTERN_TRUNCATED', pointer: '/sections/a/play/pad', requested: '2 bars', applied: '1 bars' });
    expect(n.message).toMatch(/pattern "pad-a" \(2 bars\)/);
  });

  it('is quiet when the pattern fits, and when only rests are cut off', () => {
    expect(patternTruncationNotices(song())).toEqual([]);
    // hat-a is one bar of steps; a section of two bars repeats it and cuts nothing
    expect(patternTruncationNotices(song({ sections: { a: { bars: 3, play: { pad: 'pad-a', hat: 'hat-a' } } } })).map(n => n.pointer)).toEqual(['/sections/a/play/pad']);
  });

  it('reports a master delay whose tail the render caps, and not one that fits', () => {
    expect(songDelayNotices(song({ master: { delay: { beats: 1, feedback: 0.9 } } })).map(n => n.code)).toEqual(['N_DELAY_TAIL_CAPPED']);
    expect(songDelayNotices(song({ master: { delay: { beats: 1, feedback: 0.35 } } }))).toEqual([]);
    expect(songDelayNotices(song())).toEqual([]);
  });

  it('reports a patch delay the same way', () => {
    const [n] = delayTailNotice('/fx/delay', 1, 0.9);
    expect(n).toMatchObject({ code: 'N_DELAY_TAIL_CAPPED', pointer: '/fx/delay', applied: 8 });
    expect(n.requested as number).toBeGreaterThan(8);
    expect(delayTailNotice('/fx/delay', 0.2, 0.5)).toEqual([]);
    expect(delayTailNotice('/fx/delay', 1, 0)).toEqual([]);
  });

  it('shows pattern truncation in song check', () => {
    const dir = project();
    const file = join(dir, 'cut.song.json');
    writeFileSync(file, JSON.stringify(song({ name: 'cut', sections: { a: { bars: 1, play: { pad: 'pad-a', hat: 'hat-a' } } } })));
    const r = beeps(dir, 'song', 'new', file);
    expect(r.status).toBe(0);
    expect(r.out.notices.map((n: { code: string }) => n.code)).toEqual(['N_PATTERN_TRUNCATED']);
    expect(beeps(dir, 'song', 'check', 'cut').out.songs[0].notices).toHaveLength(1);
  });
});

describe('adaptive states', () => {
  it('reports a state with no sound as silent, not as -99 LUFS', () => {
    expect(stateTrim([], 48000, -20)).toEqual({ silent: true, lufs: null, peakDb: null, trimDb: 0 });
    expect(stateTrim([new Float32Array(48000)], 48000, -20).silent).toBe(true);
  });
});
