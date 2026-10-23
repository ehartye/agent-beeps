// Strict schemas (0.26.0): a key a document does not know is an E_SCHEMA error with a pointer. For three releases (0.22.0 to 0.25.0) it was a
// warning that kept an existing file loading; this is the step after.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBatch } from '../src/batch.ts';
import { BeepsError } from '../src/errors.ts';
import { openProject, initProject, loadPatch } from '../src/project.ts';
import { resolveInstruments } from '../src/music.ts';
import { parseProject } from '../src/schema/project.ts';
import { loadRecipes } from '../src/build/config.ts';
import { NOTICE_CODES } from '../src/notices.ts';
import { coin } from './helpers/patches.ts';
import { song } from './helpers/songs.ts';
import { makeFixture } from './helpers/build-fixture.ts';
import { beeps, project } from './helpers/cli.ts';

const tryIt = (fn: () => unknown): BeepsError => {
  try { fn(); } catch (e) { return e as BeepsError; }
  throw new Error('expected an error');
};

describe('project.json', () => {
  it('rejects a misspelled key instead of leaving the default', () => {
    expect(() => parseProject({ schema: 'beeps/project@1', scal: { root: 'D' } })).toThrow(/Unrecognized key/);
    expect(() => parseProject({ schema: 'beeps/project@1', scale: { root: 'D', snapp: false } })).toThrow(/Unrecognized key/);
    expect(parseProject({ schema: 'beeps/project@1', scale: { root: 'D', mode: 'minor' } }).scale.root).toBe('D');
  });

  it('names the key in the error openProject throws', () => {
    const dir = project();
    const file = join(dir, '.agent-beeps', 'project.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), targetLoundess: -16 }));
    const e = tryIt(() => openProject(dir));
    expect(e).toMatchObject({ code: 'E_SCHEMA', pointer: '/targetLoundess', received: 'targetLoundess' });
    expect(e.hint).toMatch(/spelling/);
    const r = beeps(dir, 'list');
    expect(r.status).toBe(1);
    expect(r.err).toMatchObject({ code: 'E_SCHEMA', category: 'input', pointer: '/targetLoundess' });
  });

  it('points at a stray key nested inside scale', () => {
    const dir = project();
    const file = join(dir, '.agent-beeps', 'project.json');
    const p = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...p, scale: { ...p.scale, snapp: false } }));
    expect(tryIt(() => openProject(dir)).pointer).toBe('/scale/snapp');
  });
});

describe('batch operations', () => {
  it('rejects a misspelled key on an operation and names it', () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-batch-')));
    applyBatch(p, [{ op: 'create', patch: coin() }]);
    const e = tryIt(() => applyBatch(p, [{ op: 'set', name: 'coin', pointer: '/duration', value: 0.4, valu: 0.9 }]));
    expect(e).toMatchObject({ code: 'E_SCHEMA', pointer: '/0/valu', received: 'valu' });
    expect(loadPatch(p, 'coin').duration).toBe(0.3);
  });
});

describe('instrument overrides', () => {
  it('rejects a key that is neither base nor set', () => {
    const p = initProject(mkdtempSync(join(tmpdir(), 'beeps-ovr-')));
    const s = song({ tracks: { pad: { instrument: { base: 'bell', st: { '/layers/0/gainDb': -3 } } }, hat: { instrument: 'bell' } } });
    expect(tryIt(() => resolveInstruments(p, s))).toMatchObject({ code: 'E_SCHEMA', pointer: '/tracks/pad/instrument/st', received: 'st' });
  });
});

describe('build recipes', () => {
  it('rejects variants and seed on a song, which it never read', () => {
    const fx = makeFixture();
    fx.write('recipes.json', { plain: { source: 'songs/plain.json', role: 'ambience', seed: 3 } });
    expect(tryIt(() => loadRecipes(fx.cfg()))).toMatchObject({ code: 'E_SCHEMA', pointer: '/plain/seed' });
    fx.write('recipes.json', { plain: { source: 'songs/plain.json', role: 'ambience', variants: 2 } });
    expect(tryIt(() => loadRecipes(fx.cfg()))).toMatchObject({ pointer: '/plain/variants' });
    fx.write('recipes.json', { coin: { source: 'sfx/coin.json', role: 'sfx', seed: 4, variants: 2 } });
    expect(loadRecipes(fx.cfg())[0]).toMatchObject({ id: 'coin', seed: 4, variants: 2 });
  });
});

describe('the warning is gone', () => {
  it('has no N_UNKNOWN_KEY code left to emit', () => {
    expect(NOTICE_CODES as string[]).not.toContain('N_UNKNOWN_KEY');
  });
});
