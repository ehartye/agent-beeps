import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const writes: string[] = [];
vi.mock('../../src/atomic-write.ts', async importActual => {
  const actual = await importActual<typeof import('../../src/atomic-write.ts')>();
  return { atomicWrite: (path: string, data: string | Uint8Array) => { writes.push(basename(path)); actual.atomicWrite(path, data); } };
});

const { clampTrimDb, commit, lookup, TRIM_MAX_DB, TRIM_MIN_DB } = await import('../../src/render/cache.ts');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'beeps-cache-')); writes.length = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = { files: { 'delivered.wav': Buffer.from('wav'), 'look.png': Buffer.from('png'), 'patch.json': '{}' }, meta: { trimDb: -3.5, features: { a: 1 } } };

describe('lookup', () => {
  it('returns the parsed meta when meta.json and every named file exist', () => {
    commit(dir, entry);
    expect(lookup(dir, ['delivered.wav', 'look.png'])).toEqual(entry.meta);
  });

  it('misses when the directory does not exist', () => {
    expect(lookup(join(dir, 'nope'), ['delivered.wav'])).toBeUndefined();
  });

  it.each(['meta.json', 'delivered.wav', 'look.png'])('misses when %s is missing', missing => {
    commit(dir, entry);
    rmSync(join(dir, missing));
    expect(lookup(dir, ['delivered.wav', 'look.png'])).toBeUndefined();
  });

  it('misses on a meta.json that is not valid JSON instead of throwing', () => {
    commit(dir, entry);
    writeFileSync(join(dir, 'meta.json'), '{ half');
    expect(lookup(dir, ['delivered.wav', 'look.png'])).toBeUndefined();
  });
});

describe('commit', () => {
  it('writes the data files first, in order, and meta.json last', () => {
    commit(dir, entry);
    expect(writes).toEqual(['delivered.wav', 'look.png', 'patch.json', 'meta.json']);
    expect(readFileSync(join(dir, 'delivered.wav'), 'utf8')).toBe('wav');
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toEqual(entry.meta);
  });

  it('leaves a miss, not a hit, when a data file fails to write', () => {
    expect(() => commit(dir, { files: { 'delivered.wav': Buffer.from('wav'), 'look.png': 123 as never }, meta: { trimDb: 0 } })).toThrow();
    expect(existsSync(join(dir, 'delivered.wav'))).toBe(true);
    expect(existsSync(join(dir, 'meta.json'))).toBe(false);
    expect(lookup(dir, ['delivered.wav', 'look.png'])).toBeUndefined();
  });

  it('replaces an earlier entry and leaves no temp files behind', () => {
    commit(dir, entry);
    commit(dir, { ...entry, meta: { trimDb: 5 } });
    expect(lookup(dir, ['delivered.wav'])).toEqual({ trimDb: 5 });
    expect(readdirSync(dir).sort()).toEqual(['delivered.wav', 'look.png', 'meta.json', 'patch.json']);
  });
});

describe('clampTrimDb', () => {
  it('holds the trim to the pipeline bounds', () => {
    expect([TRIM_MIN_DB, TRIM_MAX_DB]).toEqual([-36, 24]);
    expect(clampTrimDb(-100)).toBe(-36);
    expect(clampTrimDb(100)).toBe(24);
    expect(clampTrimDb(-36)).toBe(-36);
    expect(clampTrimDb(24)).toBe(24);
    expect(clampTrimDb(-6.5)).toBe(-6.5);
  });
});
