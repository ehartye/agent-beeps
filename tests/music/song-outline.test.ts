import { describe, expect, it } from 'vitest';
import { songOutline } from '../../src/commands/songs.ts';
import { midiName } from '../../src/music.ts';
import { compileSong } from '../../runtime/engine/sequence.js';
import { PAD, song } from '../helpers/songs.ts';
import { patch } from '../helpers/patches.ts';

describe('song outline voicings', () => {
  for (const voicing of ['lead', 'spread', 'close', 'drop2', 'open'] as const) {
    for (const slash of [true, false]) {
      it(`lists the notes the compiled ${voicing} chords play with slash ${slash}`, () => {
        const s = song({
          progressions: { a: [['C/D', 4], ['Am/G', 4]] }, // slash basses outside the chord
          patterns: { 'pad-a': { bars: 2, chords: { progression: 'a', octave: 4, voicing, slash } }, 'hat-a': { bars: 1, steps: 'x' } },
        });
        const outline = songOutline(s, { pad: patch(PAD) }).voicings['pad-a'];
        const events = compileSong(s).events.filter(e => e.pattern === 'pad-a');
        const beat = 60 / s.bpm;
        const compiled = [0, 1].map(i => [...new Set(events.filter(e => e.time >= i * 4 * beat - 1e-9 && e.time < (i + 1) * 4 * beat - 1e-9).map(e => e.midi!))]
          .sort((a, b) => a - b).map(midiName).join(' '));
        // voiceLead returns each chord's voices in ascending order, as sorted here.
        expect(outline.map(line => line.split(': ')[1])).toEqual(compiled);
      });
    }
  }
});
