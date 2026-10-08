import { describe, expect, it } from 'vitest';
import { buildSong, trackShift } from '../../runtime/engine/song.js';
import { noteToHz } from '../../runtime/engine/notes.js';
import { lintSong } from '../../src/song-lint.ts';
import { songOutline } from '../../src/commands/songs.ts';
import { defaultProject } from '../../src/schema/project.ts';
import { parseSong } from '../../src/schema/song.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { patch } from '../helpers/patches.ts';
import { HAT, PAD, song, songInput } from '../helpers/songs.ts';
import type { SongFeatures } from '../../src/measure/song.ts';

const BELL = { ...PAD, name: 'bell', layers: [{ ...PAD.layers[0], source: { type: 'osc', wave: 'sine', pitch: 3300 } }] };
const good: SongFeatures = {
  durationSec: 90, integratedLufs: -24, shortTermMaxLufs: -18, loudnessRangeLu: 8, samplePeakDb: -6, truePeakDb: -5.8, crestDb: 14,
  centroidHz: 1200, flatness: 0.1, bands: [], lowShare: 0.2, stereoWidth: 0.4, arc: [], sections: [],
  delivered: { integratedLufs: -20, truePeakDb: -2, clippedSamples: 0 },
};
const tune = (over: Record<string, unknown>, notes: unknown[] = [[0, 'D4', 2]]) => song({
  tracks: { pad: { instrument: BELL, ...over }, hat: { instrument: HAT } },
  patterns: { 'pad-a': { bars: 1, notes }, 'hat-a': { bars: 1, steps: 'x' } },
});
const oscHz = (s: ReturnType<typeof song>) => {
  const f = new FakeContext();
  buildSong(asCtx(f), s, { pad: patch(BELL), hat: patch(HAT) });
  return f.nodes('osc').map(o => o.frequency.value);
};

describe('track pitch control', () => {
  it('defaults to retuning the instrument to the written note', () => {
    expect(oscHz(tune({}))[0]).toBeCloseTo(noteToHz('D4'), 2);
  });

  it('plays the instrument at its own pitch with fixed, or shifted from it with transpose', () => {
    expect(oscHz(tune({ fixed: true }))[0]).toBeCloseTo(3300, 2);
    expect(oscHz(tune({ fixed: true, transpose: 12 }))[0]).toBeCloseTo(6600, 2);
    expect(oscHz(tune({ transpose: -12 }))[0]).toBeCloseTo(noteToHz('D3'), 2);
    expect(oscHz(tune({ root: 'D4' }))[0]).toBeCloseTo(3300, 2);
  });

  it('shifts an unpitched hit by nothing', () => {
    expect(trackShift({ transpose: 7 }, patch(HAT))).toBeNull();
  });

  it('leaves a song without the new fields exactly as parsed before', () => {
    const r = parseSong(songInput());
    if (!r.ok) throw new Error('parse');
    for (const t of Object.values(r.song.tracks)) expect(Object.keys(t)).not.toEqual(expect.arrayContaining(['transpose']));
    expect(JSON.stringify(r.song)).not.toMatch(/transpose":[0-9-]+,"humanize|"fixed"/);
  });

  it('keeps the outline and register lint on the pitch that sounds', () => {
    const s = tune({ fixed: true });
    const out = songOutline(s, { pad: patch(BELL), hat: patch(HAT) });
    expect(out.tracks.pad.range).toBe('D4-D4');
    expect(out.tracks.pad.sounds).toBe('Ab7-Ab7');
  });
});

describe('song-written-pitch lint', () => {
  const inst = { pad: patch(BELL), hat: patch(HAT) };
  const warn = (s: ReturnType<typeof song>) => lintSong(s, good, defaultProject(), inst).warnings.filter(w => w.rule === 'song-written-pitch');

  it('flags a note far from the instrument root, with the fix', () => {
    const w = warn(tune({}));
    expect(w).toHaveLength(1);
    expect(w[0].pointer).toBe('/tracks/pad');
    expect(w[0].message).toMatch(/rooted at Ab7/);
    expect(w[0].message).toMatch(/3300 Hz/);
    expect(w[0].message).toMatch(/294 Hz/);
    expect(w[0].message).toMatch(/"fixed": true/);
    expect(w[0].message).toMatch(/"root": "D4"/);
  });

  it('is quiet once the track says what it means, or the note is near the root', () => {
    expect(warn(tune({ fixed: true }))).toEqual([]);
    expect(warn(tune({ root: 'D4' }))).toEqual([]);
    expect(warn(tune({ transpose: 12 }, [[0, 'C4', 1]]))).toHaveLength(1);
    expect(lintSong(song(), good, defaultProject(), { pad: patch(PAD), hat: patch(HAT) }).warnings.filter(w => w.rule === 'song-written-pitch')).toEqual([]);
  });

  it('ignores unpitched instruments', () => {
    const s = song({ tracks: { pad: { instrument: PAD }, hat: { instrument: HAT, transpose: 30 } } });
    expect(lintSong(s, good, defaultProject(), { pad: patch(PAD), hat: patch(HAT) }).warnings.filter(w => w.rule === 'song-written-pitch')).toEqual([]);
  });
});
