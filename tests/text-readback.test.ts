// 0.28.0: a song and a recording as text, for an agent that cannot view the look image.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ROWS, parseBars, songRoll } from '../src/song-roll.ts';
import { digestAudio, MAX_WINDOWS } from '../src/samples/digest.ts';
import { writeWav } from '../src/audio/wav.ts';
import { PAD, HAT, song } from './helpers/songs.ts';
import { beeps, project } from './helpers/cli.ts';

const thrown = (fn: () => unknown) => { try { fn(); } catch (e) { return e as Error & { code?: string; hint?: string }; } throw new Error('expected an error'); };

const lead = (extra: Record<string, unknown> = {}) => song({
  tracks: { lead: { instrument: PAD }, perc: { instrument: HAT } },
  patterns: {
    melody: { bars: 2, notes: [[0, 'C4', 1], [1, 'E4', 2], [4, 'G4', 1]] },
    beat: { bars: 1, steps: 'x...x...x...x...' },
  },
  sections: { a: { bars: 2, play: { lead: 'melody', perc: 'beat' } }, b: { bars: 12, play: { perc: 'beat' } } },
  form: ['a', 'b'],
  ...extra,
});

describe('--bars', () => {
  it('reads a bar or a range', () => {
    expect(parseBars('3')).toEqual([3, 3]);
    expect(parseBars('2-6')).toEqual([2, 6]);
    for (const bad of ['0', '5-2', 'a', '1-', '1,2']) expect(thrown(() => parseBars(bad)), bad).toMatchObject({ code: 'E_USAGE' });
  });
});

describe('song roll', () => {
  it('draws pitched parts as a roll, highest pitch first, one column per sixteenth', () => {
    const r = songRoll(lead(), { section: 'a', tracks: ['lead'] });
    expect(r.window).toEqual({ bars: [1, 2], of: 2 });
    expect(r.tracks.lead.notes).toBe(3);
    expect(r.tracks.lead.rows).toEqual([
      { label: 'G4', cells: '................|o###............' },
      { label: 'E4', cells: '....o#######....|................' },
      { label: 'C4', cells: 'o###............|................' },
    ]);
    expect(r.text.split('\n')[0]).toMatch(/^lead|song|test-song \/ a, bars 1-2 of 2/);
    expect(r.text).toContain('G4   ................|o###............');
  });

  it('draws rhythm parts on one row of single hits', () => {
    const r = songRoll(lead(), { section: 'a', tracks: ['perc'] });
    expect(r.tracks.perc.notes).toBe(8);
    expect(r.tracks.perc.rows).toHaveLength(1);
    expect(r.tracks.perc.rows[0].cells).toBe('o...o...o...o...|o...o...o...o...');
  });

  it('shows every sounding track by default and only the asked-for ones otherwise', () => {
    expect(Object.keys(songRoll(lead(), { section: 'a' }).tracks)).toEqual(['lead', 'perc']);
    expect(Object.keys(songRoll(lead(), { section: 'b' }).tracks)).toEqual(['perc']);
  });

  it('shows a window of bars and names the next one', () => {
    const first = songRoll(lead(), { section: 'b' });
    expect(first.window).toEqual({ bars: [1, 8], of: 12 });
    expect(first.next).toBe('beeps song roll test-song --section b --bars 9-12');
    const last = songRoll(lead(), { section: 'b', bars: [9, 20] });
    expect(last.window).toEqual({ bars: [9, 12], of: 12 });
    expect(last.next).toBeUndefined();
    expect(songRoll(lead(), { section: 'b', bars: [3, 3] }).tracks.perc.rows[0].cells).toBe('o...o...o...o...');
  });

  it('defaults to the first section of the form', () => {
    expect(songRoll(lead()).section).toBe('a');
  });

  it('refuses a section, a track or a bar that is not there, naming what is', () => {
    expect(thrown(() => songRoll(lead(), { section: 'zzz' }))).toMatchObject({ code: 'E_USAGE', hint: 'sections: a, b' });
    expect(thrown(() => songRoll(lead(), { tracks: ['bass'] }))).toMatchObject({ code: 'E_USAGE', hint: 'tracks: lead, perc' });
    expect(thrown(() => songRoll(lead(), { section: 'a', bars: [5, 6] }))).toMatchObject({ code: 'E_USAGE' });
  });

  it('keeps the most used pitches when a part has more rows than the cap', () => {
    const notes = Array.from({ length: MAX_ROWS + 4 }, (_, i) => [i * 0.25, ['C', 'D', 'E', 'F', 'G', 'A', 'B'][i % 7] + (2 + Math.floor(i / 7)), 0.25]);
    const wide = song({ patterns: { melody: { bars: 2, notes }, beat: { bars: 1, steps: 'x...' } }, tracks: { lead: { instrument: PAD }, perc: { instrument: HAT } },
      sections: { a: { bars: 2, play: { lead: 'melody', perc: 'beat' } } } });
    const r = songRoll(wide, { section: 'a', tracks: ['lead'] });
    expect(r.tracks.lead.rows).toHaveLength(MAX_ROWS);
    expect(r.tracks.lead.rowsOmitted).toBe(4);
    expect(r.text).toMatch(/4 rarely used pitches left out/);
  });

  it('works from the command line', () => {
    const dir = project();
    const file = join(dir, 'lead.song.json');
    writeFileSync(file, JSON.stringify({ ...lead(), name: 'lead' }));
    expect(beeps(dir, 'song', 'new', file).status).toBe(0);
    const r = beeps(dir, 'song', 'roll', 'lead', '--section', 'a', '--track', 'lead', '--bars', '1-1');
    expect(r.status).toBe(0);
    expect(r.out.tracks.lead.rows[0].cells).toBe('................');
    expect(r.out.text).toContain('bars 1-1 of 2');
    expect(beeps(dir, 'song', 'roll', 'lead', '--bars', 'x').err.code).toBe('E_USAGE');
  });
});

describe('sample digest', () => {
  const SR = 48000;
  const tone = (hz: number, sec: number, amp = 0.5) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
  const concat = (...parts: Float32Array[]) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
  const clip = concat(new Float32Array(SR), tone(440, 1), new Float32Array(SR), tone(2000, 1, 0.1));

  it('reads silence, a steady pitch, brightness and level per window', () => {
    const d = digestAudio([clip], { startFrame: 0, endFrame: clip.length, windows: 4 });
    expect(d.windows.map(w => [w.startSec, w.endSec])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    expect(d.windows[0]).toMatchObject({ rmsDb: null, peakDb: null, centroidHz: null, pitchHz: null, events: 0 });
    expect(d.windows[2].rmsDb).toBeNull();
    const a = d.windows[1], b = d.windows[3];
    expect(a.pitchHz).toBeGreaterThan(436);
    expect(a.pitchHz).toBeLessThan(444);
    expect(a.peakDb).toBeCloseTo(-6, 0);
    expect(a.centroidHz!).toBeLessThan(700);
    expect(b.pitchHz!).toBeGreaterThan(1950);
    expect(b.centroidHz!).toBeGreaterThan(1500);
    expect(b.peakDb!).toBeLessThan(a.peakDb! - 10);
    expect(a.events).toBeGreaterThanOrEqual(1);
  });

  it('lays the table out with a header and one row per window', () => {
    const d = digestAudio([clip], { startFrame: 0, endFrame: clip.length, windows: 4 });
    const lines = d.text.split('\n');
    expect(lines).toHaveLength(2 + 4);
    expect(lines[0]).toMatch(/^4 windows of 1 s from 0 s to 4 s/);
    expect(lines[2]).toMatch(/^\s+1\s+0\s+1\s+-\s+-\s+-\s+-\s+0$/);
  });

  it('digests a part of the source, with times in source seconds, and caps the window count', () => {
    const d = digestAudio([clip], { startFrame: SR, endFrame: 2 * SR, windows: 2 });
    expect(d.windows.map(w => [w.startSec, w.endSec])).toEqual([[1, 1.5], [1.5, 2]]);
    expect(digestAudio([clip], { startFrame: 0, endFrame: clip.length, windows: 5000 }).windows.length).toBeLessThanOrEqual(MAX_WINDOWS);
  });

  it('works from the command line on an audio file, and rejects a range outside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-digest-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'clip.wav');
    writeFileSync(file, writeWav([clip], SR));
    const r = beeps(dir, 'sample', 'digest', file, '--windows', '4');
    expect(r.status).toBe(0);
    expect(r.out.windows).toHaveLength(4);
    expect(r.out.source.durationSec).toBe(4);
    expect(beeps(dir, 'sample', 'digest', file, '--start', '9').err.code).toBe('E_SCHEMA');
    expect(beeps(dir, 'sample', 'digest', file, '--windows', '0').status).toBe(2);
  });
});
