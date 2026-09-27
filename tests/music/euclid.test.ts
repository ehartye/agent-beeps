import { describe, expect, it } from 'vitest';
import { expandEuclid, parseSteps } from '../../runtime/engine/sequence.js';
import { z } from 'zod';
import { parseSong, SongSchema } from '../../src/schema/song.ts';
import { songInput } from '../helpers/songs.ts';

// Toussaint, "The Euclidean Algorithm Generates Traditional Musical Rhythms" (2005), Bjorklund forms.
const TOUSSAINT: [number, number, string][] = [
  [2, 5, 'x.x..'], [3, 4, 'x.xx'], [3, 5, 'x.x.x'], [3, 7, 'x.x.x..'], [3, 8, 'x..x..x.'],
  [4, 7, 'x.x.x.x'], [4, 9, 'x.x.x.x..'], [4, 11, 'x..x..x..x.'], [5, 6, 'x.xxxx'], [5, 7, 'x.xx.xx'],
  [5, 8, 'x.xx.xx.'], [5, 9, 'x.x.x.x.x'], [5, 11, 'x.x.x.x.x..'], [5, 12, 'x..x.x..x.x.'],
  [5, 16, 'x..x..x..x..x...'], [7, 8, 'x.xxxxxx'], [7, 12, 'x.xx.x.xx.x.'], [7, 16, 'x..x.x.x..x.x.x.'],
];

describe('euclidean step rhythms', () => {
  for (const [k, n, want] of TOUSSAINT) {
    it(`x(${k},${n}) spreads ${k} hits over ${n} steps as ${want}`, () => expect(expandEuclid(`x(${k},${n})`)).toBe(want));
  }

  it('keeps full and single-hit cases and uses the leading glyph for every hit', () => {
    expect(expandEuclid('X(4,4)')).toBe('XXXX');
    expect(expandEuclid('o(1,4)')).toBe('o...');
    expect(expandEuclid('?(2,4)')).toBe('?.?.');
  });

  it('rotates left by the third number, modulo the step count', () => {
    expect(expandEuclid('x(3,8,1)')).toBe('..x..x.x');
    expect(expandEuclid('x(3,8,9)')).toBe(expandEuclid('x(3,8,1)'));
  });

  it('expands in place beside literal steps, spaces and bar lines', () => {
    expect(expandEuclid('X... | x(3,5) _')).toBe('X... | x.x.x _');
    expect(parseSteps('x(3,8)')).toEqual(parseSteps('x..x..x.'));
  });

  it('rejects impossible counts', () => {
    expect(() => expandEuclid('x(0,8)')).toThrow(/hits/);
    expect(() => expandEuclid('x(9,8)')).toThrow(/hits/);
    expect(() => expandEuclid('x(3,65)')).toThrow(/steps/);
  });
});

describe('euclidean rhythms in songs', () => {
  const withSteps = (steps: string) => parseSong(songInput({ patterns: {
    'pad-a': { bars: 2, chords: { progression: 'a', rhythm: 'x(3,8)' } },
    'hat-a': { bars: 1, steps },
  } }));

  it('accepts them in steps and rhythm fields', () => expect(withSteps('X(5,16)').ok).toBe(true));

  it('reports an impossible euclidean token once, against its field', () => {
    const r = withSteps('x(9,8)');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ pointer: '/patterns/hat-a/steps', message: expect.stringMatching(/hits must be 1-8/) });
    }
  });

  it('reports a malformed token once, with the grammar', () => {
    const r = withSteps('x(3)');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0].message).toMatch(/x\(3,8\)/);
    }
  });

  it('publishes the step grammar, euclidean tokens included, in the JSON schema', () => {
    const schema = z.toJSONSchema(SongSchema, { io: 'input' }) as any;
    const pattern = schema.properties.patterns.additionalProperties.properties.steps.pattern as string;
    expect(pattern).toBeTypeOf('string');
    expect(new RegExp(pattern).test('X... x(3,8) o(5,16,2) _')).toBe(true);
    expect(new RegExp(pattern).test('x(3)')).toBe(false);
  });
});
