import { describe, expect, it } from 'vitest';
import { escapePointer, getPointer, hasPointer, parsePointer, removePointer, replacePointer, tryGetPointer, unescapePointer } from '../src/pointer.ts';
import { BeepsError } from '../src/errors.ts';
import { pointerOf } from '../src/schema/patch.ts';

const doc = () => ({ 'a/b': { 'm~n': 1 }, list: [{ x: 1 }, { x: 2 }], zero: 0, none: null });

describe('pointer escaping', () => {
  it('escapes and unescapes keys, and round-trips them', () => {
    expect(escapePointer('a/b~c')).toBe('a~1b~0c');
    expect(unescapePointer('a~1b~0c')).toBe('a/b~c');
    expect(unescapePointer('~01')).toBe('~1'); // ~0 decodes after ~1, so an escaped tilde followed by 1 is not a slash
    for (const k of ['', '~', '/', '~/', '~0', '~1', 'plain']) expect(unescapePointer(escapePointer(k))).toBe(k);
  });

  it('is what parsePointer and pointerOf use', () => {
    expect(parsePointer('/a~1b/m~0n')).toEqual(['a/b', 'm~n']);
    expect(pointerOf(['a/b', 'm~n', 2])).toBe('/a~1b/m~0n/2');
    expect(pointerOf([])).toBe('');
  });
});

describe('getPointer and tryGetPointer', () => {
  it('resolve the same values, including falsy ones and the root', () => {
    const d = doc();
    for (const [ptr, want] of [['/a~1b/m~0n', 1], ['/list/1/x', 2], ['/zero', 0], ['/none', null], ['', d]] as const) {
      expect(getPointer(d, ptr)).toBe(want);
      expect(tryGetPointer(d, ptr)).toBe(want);
    }
  });

  it('getPointer throws E_USAGE naming the missing step; tryGetPointer returns undefined', () => {
    const d = doc();
    for (const ptr of ['/nope', '/list/2/x', '/zero/x', '/none/x', '/list/01', '/list/length', '/toString', '/list/-']) {
      expect(() => getPointer(d, ptr), ptr).toThrow(BeepsError);
      expect(tryGetPointer(d, ptr), ptr).toBeUndefined();
      expect(hasPointer(d, ptr), ptr).toBe(false);
    }
    expect(() => getPointer(d, '/list/2/x')).toThrow('pointer /list/2/x does not resolve at "2"');
  });

  it('tryGetPointer never throws, even for a malformed pointer', () => {
    expect(tryGetPointer(doc(), 'no-slash')).toBeUndefined();
    expect(() => getPointer(doc(), 'no-slash')).toThrow(/must start with "\/"/);
  });
});

describe('replacePointer', () => {
  it('replaces what exists, by key and array index', () => {
    const d: any = doc();
    replacePointer(d, '/a~1b/m~0n', 5);
    replacePointer(d, '/list/0/x', 9);
    replacePointer(d, '/top', true);
    expect([d['a/b']['m~n'], d.list[0].x, d.top]).toEqual([5, 9, true]);
  });

  it('creates nothing: a missing parent, array index or root is E_USAGE', () => {
    const d: any = doc();
    expect(() => replacePointer(d, '/list/7', 1)).toThrow(/no array index 7/);
    expect(() => replacePointer(d, '/missing/x', 1)).toThrow(/no value at missing on the way/);
    expect(() => replacePointer(d, '/zero/x', 1)).toThrow(/no object at the parent|no value at/);
    expect(() => replacePointer(d, '', 1)).toThrow(/cannot set the root/);
    expect(d.missing).toBeUndefined();
  });

  it('refuses prototype-related keys', () => {
    expect(() => replacePointer({}, '/__proto__', 1)).toThrow(/unsafe pointer/);
  });
});

describe('removePointer', () => {
  it('removes object keys and splices array entries', () => {
    const d: any = doc();
    removePointer(d, '/a~1b/m~0n');
    removePointer(d, '/list/0');
    expect(d['a/b']).toEqual({});
    expect(d.list).toEqual([{ x: 2 }]);
  });

  it('finds a parent whose key needs escaping', () => {
    const d: any = { 'a/b': { c: 1, d: 2 } };
    removePointer(d, '/a~1b/c');
    expect(d).toEqual({ 'a/b': { d: 2 } });
  });
});
