import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BeepsError, ERROR_CATEGORIES, ERROR_CODES, toErrorJson } from '../src/errors.ts';

const bin = join(import.meta.dirname, '..', 'scripts', 'beeps.mjs');
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true });
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { status: r.status, out: parse(r.stdout), err: parse(r.stderr)?.error };
};

describe('the error contract', () => {
  it('keeps a BeepsError as it is', () => {
    const e = new BeepsError('E_SCHEMA', 'bad', { pointer: '/a', hint: 'fix a' });
    expect(toErrorJson(e)).toEqual({ code: 'E_SCHEMA', category: 'input', retryable: false, message: 'bad', pointer: '/a', hint: 'fix a' });
  });

  it('reports a TypeError or ReferenceError as an internal bug, not as a render failure', () => {
    for (const e of [new TypeError('x is not a function'), new ReferenceError('y is not defined')]) {
      const j = toErrorJson(e, false);
      expect(j.code).toBe('E_INTERNAL');
      expect(j.message).toBe(e.message);
      expect(j.hint).toMatch(/BEEPS_DEBUG/);
      expect(j).not.toHaveProperty('stack');
    }
  });

  it('adds the stack only when debugging is on', () => {
    expect(toErrorJson(new TypeError('boom'), true).stack).toMatch(/TypeError: boom/);
  });

  it('keeps other plain errors as E_RENDER, the failure code for work that ran and failed', () => {
    expect(toErrorJson(new Error('chromium exploded'), false)).toEqual({ code: 'E_RENDER', category: 'outcome', retryable: false, message: 'chromium exploded' });
    expect(toErrorJson('a string', false).code).toBe('E_RENDER');
  });

  it('lists E_INTERNAL among the codes', () => {
    expect(ERROR_CODES).toContain('E_INTERNAL');
  });
});

describe('error categories', () => {
  it('gives every code a category, so a new code cannot ship without one', () => {
    for (const code of ERROR_CODES) expect(Object.keys(ERROR_CATEGORIES), code).toContain(code);
    expect(Object.keys(ERROR_CATEGORIES).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('marks only transient failures as worth retrying', () => {
    const retryable = ERROR_CODES.filter(c => new BeepsError(c, 'x').toJson().retryable);
    expect(retryable.sort()).toEqual(['E_LOCK', 'E_SERVER', 'E_STORE']);
    expect(new BeepsError('E_SCHEMA', 'x').toJson().category).toBe('input');
    expect(new BeepsError('E_BROWSER_MISSING', 'x').toJson().category).toBe('environment');
    expect(new BeepsError('E_INTERNAL', 'x').toJson().category).toBe('bug');
  });

  it('echoes the rejected value, truncated, when the caller supplies it', () => {
    const e = new BeepsError('E_SCHEMA', 'bad', { pointer: '/a', received: 'x'.repeat(200) });
    const j = toErrorJson(e);
    expect(j.received).toBe('x'.repeat(79) + '…');
    expect(toErrorJson(new BeepsError('E_SCHEMA', 'bad', { pointer: '/a', received: { n: 1 } })).received).toBe('{"n":1}');
    expect(toErrorJson(new BeepsError('E_SCHEMA', 'bad')).received).toBeUndefined();
  });

  it('labels an internal bug as such', () => {
    expect(toErrorJson(new TypeError('x'), false)).toMatchObject({ code: 'E_INTERNAL', category: 'bug', retryable: false });
  });
});

describe('usage errors from option parsing', () => {
  it('reports a non-integer option value as E_USAGE with exit 2', () => {
    const r = run('instruments', 'rebase', 'soft-pluck', '--by', 'abc');
    expect(r.status).toBe(2);
    expect(r.err.code).toBe('E_USAGE');
    expect(r.err.message).toMatch(/expected an integer/);
  });

  it('reports a fractional integer option as E_USAGE', () => {
    expect(run('instruments', 'rebase', 'soft-pluck', '--by', '1.5').err.code).toBe('E_USAGE');
  });
});
