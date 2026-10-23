// Honest feedback, Phase 2c (0.22.0): a key a schema does not know is reported instead of dropped, and a song says what the sequencer and
// the effects cut. From 0.25.0 an unknown key is an E_SCHEMA error; the tolerant parse here is the one place that changes.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { drainNotices } from '../src/notices.ts';
import { parseTolerant, unknownKeyNotices } from '../src/strict-parse.ts';
import { parseProject } from '../src/schema/project.ts';
import { applyBatch } from '../src/batch.ts';
import { initProject, loadPatch } from '../src/project.ts';
import { resolveInstruments } from '../src/music.ts';
import { stateTrim } from '../src/render/layers.ts';
import { delayTailNotice } from '../src/patch-notices.ts';
import { patternTruncationNotices, songDelayNotices } from '../src/song-notices.ts';
import { loadRecipes } from '../src/build/config.ts';
import { coin } from './helpers/patches.ts';
import { song } from './helpers/songs.ts';
import { makeFixture } from './helpers/build-fixture.ts';
import { add, beeps, project } from './helpers/cli.ts';

afterEach(() => { drainNotices(); });

describe('tolerant parsing of a strict schema', () => {
  const Inner = z.strictObject({ a: z.number(), deep: z.strictObject({ x: z.number() }).optional() });

  it('strips unknown keys and says where they were', () => {
    const r = parseTolerant(Inner, { a: 1, typo: 2, deep: { x: 1, extra: true } });
    expect(r).toMatchObject({ ok: true, data: { a: 1, deep: { x: 1 } } });
    expect(r.ok && [...r.unknown].sort((a, b) => a.pointer.localeCompare(b.pointer))).toEqual([{ pointer: '/deep/extra', key: 'extra' }, { pointer: '/typo', key: 'typo' }]);
  });

  it('is exactly the plain parse when nothing is unknown', () => {
    expect(parseTolerant(Inner, { a: 1 })).toEqual({ ok: true, data: { a: 1 }, unknown: [] });
  });

  it('still fails on anything else that is wrong, with the unknown keys already stripped', () => {
    const r = parseTolerant(Inner, { a: 'one', typo: 2 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.issues.map(i => i.code)).toEqual(['invalid_type']);
  });

  it('turns each stripped key into one N_UNKNOWN_KEY notice with its pointer', () => {
    const r = parseTolerant(Inner, { a: 1, typo: 2 });
    const [n] = unknownKeyNotices(r.ok ? r.unknown : [], 'a test document');
    expect(n).toMatchObject({ code: 'N_UNKNOWN_KEY', severity: 'warn', pointer: '/typo', requested: 'typo' });
    expect(n.message).toMatch(/"typo" is not a key a test document knows/);
  });
});

describe('project.json', () => {
  it('reports a misspelled key, and keeps the default it left in place', () => {
    const p = parseProject({ schema: 'beeps/project@1', scal: { root: 'D' }, targetLoudness: -16 });
    expect(p.scale.root).toBe('C');
    expect(p.targetLoudness).toBe(-16);
    const [n] = drainNotices();
    expect(n).toMatchObject({ code: 'N_UNKNOWN_KEY', pointer: '/scal' });
    expect(n.message).toMatch(/project\.json/);
  });

  it('reports a stray key inside scale', () => {
    parseProject({ schema: 'beeps/project@1', scale: { root: 'D', snapp: false } });
    expect(drainNotices().map(n => n.pointer)).toEqual(['/scale/snapp']);
  });

  it('says nothing for a clean project', () => {
    parseProject({ schema: 'beeps/project@1', scale: { root: 'D', mode: 'minor' } });
    expect(drainNotices()).toEqual([]);
  });

  it('shows up in the JSON of any command that reads the project', () => {
    const dir = project();
    const file = join(dir, '.agent-beeps', 'project.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), targetLoundess: -16 }));
    const r = beeps(dir, 'list');
    expect(r.status).toBe(0);
    expect(r.out.notices).toHaveLength(1);
    expect(r.out.notices[0]).toMatchObject({ code: 'N_UNKNOWN_KEY', pointer: '/targetLoundess' });
  });
});

describe('batch operations', () => {
  it('reports a misspelled key on an operation', () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-batch-')));
    applyBatch(p, [{ op: 'create', patch: coin() }]);
    const r = applyBatch(p, [{ op: 'set', name: 'coin', pointer: '/duration', value: 0.4, valu: 0.9 }]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices![0]).toMatchObject({ code: 'N_UNKNOWN_KEY', pointer: '/0/valu' });
    expect(loadPatch(p, 'coin').duration).toBe(0.4);
  });

  it('is quiet when every key is known', () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-batch-')));
    expect(applyBatch(p, [{ op: 'create', patch: coin() }]).notices).toBeUndefined();
  });
});

describe('instrument overrides', () => {
  it('reports a key that is neither base nor set', () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-ovr-')));
    const s = song({ tracks: { pad: { instrument: { base: 'bell', st: { '/layers/0/gainDb': -3 } } }, hat: { instrument: 'bell' } } });
    resolveInstruments(p, s);
    expect(drainNotices()).toEqual([expect.objectContaining({ code: 'N_UNKNOWN_KEY', pointer: '/tracks/pad/instrument/st' })]);
  });
});

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

describe('build recipes', () => {
  it('notes the variants and seed a song recipe sets and never reads', () => {
    const fx = makeFixture();
    fx.write('recipes.json', {
      coin: { source: 'sfx/coin.json', role: 'sfx', seed: 4 },
      plain: { source: 'songs/plain.json', role: 'ambience', seed: 3, variants: 2 },
    });
    const byId = Object.fromEntries(loadRecipes(fx.cfg()).map(r => [r.id, r]));
    expect(byId.plain.ignored).toEqual(['variants', 'seed']);
    expect(byId.coin.ignored).toBeUndefined();
  });
});

describe('add() helper sanity', () => {
  it('leaves the shared CLI harness usable from this file', () => {
    const dir = project();
    add(dir, coin());
    expect(beeps(dir, 'list').out.patches.map((x: { name: string }) => x.name)).toContain('coin');
  });
});
