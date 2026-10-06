import { describe, expect, it } from 'vitest';
import { FEATURE_NAMES } from '../../src/measure/index.ts';
import { FeedbackSchema, verdictsFromFeedback, type RatedSound } from '../../src/taste/feedback.ts';
import { VerdictSchema } from '../../src/taste/verdicts.ts';

const D = FEATURE_NAMES.length;
const raw = (v: number) => Array.from({ length: D }, (_, i) => v + i * 0.1);
const base = { project: 'p', session: 'import-1', at: '2026-10-06T00:00:00.000Z' };
const s = (name: string, family: string, rating: 'up' | 'down', v: number): RatedSound => ({ name, family, raw: raw(v), rating });

describe('listening-page feedback to verdicts', () => {
  it('pairs every liked sound with every disliked one in its family, as a lineup does', () => {
    const { rows, unpaired } = verdictsFromFeedback([s('a', 'foley', 'up', 1), s('b', 'foley', 'up', 2), s('c', 'foley', 'down', 3), s('d', 'ui-click', 'up', 4)], base);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.kind).toBe('implied');
      expect(r.weight).toBeCloseTo(1 / 3);
      expect(r.loser!.name).toBe('c');
      expect(r.tags).toContain('feedback');
      expect(VerdictSchema.safeParse(r).success).toBe(true);
    }
    expect(rows.map(r => r.winner!.name).sort()).toEqual(['a', 'b']);
    // a like with nothing disliked beside it has nothing to be compared with
    expect(unpaired).toEqual(['d']);
  });

  it('a disliked sound with nothing liked in its family is a bothBad row against the family mean', () => {
    const { rows } = verdictsFromFeedback([s('x', 'no', 'down', 1), s('y', 'foley', 'up', 2)], base);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'bothBad', weight: 0.5, loser: { name: 'x', family: 'no' } });
  });

  it('feature vectors are standardised across the rated set, like a session', () => {
    const { rows } = verdictsFromFeedback([s('lo', 'f', 'up', 0), s('hi', 'f', 'down', 10)], base);
    const [r] = rows;
    // winner and loser are on opposite sides of the mean
    expect(r!.winner!.x[0]! * r!.loser!.x[0]!).toBeLessThan(0);
  });

  it('accepts what the audition page exports and rejects other json', () => {
    expect(FeedbackSchema.safeParse({ schema: 'fallow-valley/audition-feedback@1', items: [{ name: 'step-salt', rating: 'up', level: null, note: '' }, { name: 'deny-tool', rating: null, level: 'quieter' }] }).success).toBe(true);
    expect(FeedbackSchema.safeParse({ schema: 'beeps/patch@1', items: [] }).success).toBe(false);
    expect(FeedbackSchema.safeParse({ schema: 'x/audition-feedback@1', items: [{ name: 'a', rating: 'meh' }] }).success).toBe(false);
  });
});
