import { describe, expect, it } from 'vitest';
import { setPointer } from '../src/pointer.ts';

describe('JSON pointer writes', () => {
  it.each(['/__proto__/beepsPointerTest', '/nested/__proto__/beepsPointerTest', '/constructor/prototype/beepsPointerTest', '/nested/prototype/value', '/nested/__proto__'])('rejects prototype-related path %s before changing anything', pointer => {
    const doc = {};
    try {
      expect(() => setPointer(doc, pointer, true)).toThrow(/unsafe pointer/);
      expect(doc).toEqual({});
      expect(Object.prototype).not.toHaveProperty('beepsPointerTest');
    } finally {
      delete (Object.prototype as Record<string, unknown>).beepsPointerTest;
    }
  });

  it('still creates ordinary objects, decodes keys and appends array entries', () => {
    const doc = { list: [1] };
    setPointer(doc, '/nested/a~1b/m~0n', 2);
    setPointer(doc, '/list/-', 3);
    expect(doc).toEqual({ nested: { 'a/b': { 'm~n': 2 } }, list: [1, 3] });
  });
});
