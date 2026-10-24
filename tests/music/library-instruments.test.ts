// The bundled instruments (library/instruments), including the dance-music synths added in 0.33.0.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPatch } from '../../runtime/engine/patch.js';
import { buildSong } from '../../runtime/engine/song.js';
import { instrumentRoot } from '../../runtime/engine/song.js';
import { initProject } from '../../src/project.ts';
import { resolveInstruments } from '../../src/music.ts';
import { parsePatch } from '../../src/schema/patch.ts';
import { FakeContext, asCtx } from '../helpers/fake-context.ts';
import { song } from '../helpers/songs.ts';

const DIR = resolve(import.meta.dirname, '..', '..', 'library', 'instruments');
const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

/** Added in 0.33.0 from the tribute album's inline synths; a song can name each one. */
const SYNTH_LAB = ['supersaw', 'trance-lead', 'prog-pluck', 'rave-stab', 'prog-pad', 'hoover', 'screech', 'acid-bass', 'reese', 'bounce-bass', 'wonk-bass',
  'wobble', 'growl', 'vox-ah', 'vox-oo', 'vox-ee', 'deep-kick', 'punch-kick', 'sub-boom', 'snare-dub', 'snare-dnb', 'clap', 'open-hat', 'crash', 'riser', 'glitch'];

describe('library instruments', () => {
  it('has every synth-lab instrument', () => {
    for (const name of SYNTH_LAB) expect(files, name).toContain(`${name}.json`);
  });

  it.each(files)('%s parses, is named for its file and says what it is for', f => {
    const input = read(f);
    const r = parsePatch(input);
    expect(r.ok, JSON.stringify(r.ok ? [] : r.issues)).toBe(true);
    expect(input.name).toBe(f.replace(/\.json$/, ''));
    expect(input.family).toBe('music');
    expect(String(input.meta?.description ?? '').length).toBeGreaterThan(30);
    expect(input.tags.length).toBeGreaterThan(0);
  });

  it.each(files)('%s builds a graph', f => {
    const r = parsePatch(read(f));
    if (!r.ok) throw new Error('does not parse');
    const fake = new FakeContext();
    expect(() => buildPatch(asCtx(fake), r.patch, { seed: 1 })).not.toThrow();
    expect(fake.created.length).toBeGreaterThan(0);
  });

  it('gives each pitched synth-lab instrument a root a song can retune from', () => {
    for (const name of SYNTH_LAB) {
      const r = parsePatch(read(`${name}.json`));
      if (!r.ok) throw new Error(name);
      // drums, impacts, the riser and the glitch bed are not played at written pitches
      const notMelodic = ['deep-kick', 'punch-kick', 'sub-boom', 'snare-dub', 'snare-dnb', 'clap', 'open-hat', 'crash', 'riser', 'glitch'];
      if (!notMelodic.includes(name)) expect(instrumentRoot(r.patch), name).not.toBeNull();
    }
  });
});

describe('tempo-synced library instruments', () => {
  const project = initProject(mkdtempSync(join(tmpdir(), 'beeps-lib-')));
  const lfoHz = (bpm: number, instrument: unknown) => {
    const s = song({ bpm, tracks: { bass: { instrument } }, patterns: { line: { bars: 1, notes: [[0, 'C2', 1, 1]] } }, sections: { a: { bars: 1, play: { bass: 'line' } } }, form: ['a'] });
    const f = new FakeContext();
    buildSong(asCtx(f), s, resolveInstruments(project, s));
    return f.nodes('osc').filter(o => o.frequency.value < 30).map(o => o.frequency.value as number);
  };

  it('wobble follows the song tempo at eighth notes', () => {
    expect(lfoHz(120, 'wobble')).toEqual([4]);
    expect(lfoHz(90, 'wobble')).toEqual([3]);
  });

  it('growl follows it in triplet eighths, and a { base, set } override picks another division', () => {
    expect(lfoHz(120, 'growl')).toEqual([6]);
    expect(lfoHz(120, { base: 'wobble', set: { '/layers/0/lfo/sync': 1 } })).toEqual([2]);
  });

  it('keeps the fixed rate as the fallback for a wobble played alone', () => {
    const r = parsePatch(read('wobble.json'));
    if (!r.ok) throw new Error('does not parse');
    expect(r.patch.layers[0].lfo).toMatchObject({ rate: 3.5, sync: 2 });
    const f = new FakeContext(); buildPatch(asCtx(f), r.patch, { seed: 1 });
    expect(f.nodes('osc').filter(o => o.frequency.value < 30).map(o => o.frequency.value)).toEqual([3.5]);
  });
});
