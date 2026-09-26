import { describe, expect, it } from 'vitest';
import { canonicalJson, renderKey } from '../src/hash.ts';
import { BeepsError } from '../src/errors.ts';

describe('hash', () => {
  it('canonicalizes key order recursively', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":[2,{"c":0,"d":1}],"b":1}');
  });
  it('keys renders by patch and options', () => {
    const k = renderKey({ x: 1 }, { seed: 1, variant: 0 });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(renderKey({ x: 1 }, { variant: 0, seed: 1 })).toBe(k);
    expect(renderKey({ x: 1 }, { seed: 2, variant: 0 })).not.toBe(k);
  });
});

describe('BeepsError', () => {
  it('serializes code, pointer and hint', () => {
    const e = new BeepsError('E_SCHEMA', 'bad', { pointer: '/a', hint: 'h' });
    expect(e.toJson()).toEqual({ code: 'E_SCHEMA', message: 'bad', pointer: '/a', hint: 'h' });
  });
});
