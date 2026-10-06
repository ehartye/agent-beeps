// Turn thumbs from a listening page that is not an audition (a game's own "click through every sound" page) into taste verdicts.
// A thumb is one sound judged alone, not a pair, so it is paired the way a lineup is: within a family, every liked sound beats every
// disliked one (kind "implied", weight 1/3, exactly what lineup hearts and crosses produce), and a disliked sound with nothing liked
// beside it is a "bothBad" row against the family-mean reference. A liked sound with nothing disliked beside it says nothing about
// what to move away from, so it is reported, not logged.
import { z } from 'zod';
import { tasteVectors } from '../audition/session.ts';
import type { Verdict } from './verdicts.ts';

/** What a listening page exports (`fallow-valley/audition-feedback@1` is one; any page that writes this shape works). */
export const FeedbackItemSchema = z.object({
  name: z.string().min(1),
  rating: z.enum(['up', 'down']).nullable().optional(),
  level: z.string().nullable().optional(),
  note: z.string().optional(),
});
export const FeedbackSchema = z.object({
  schema: z.string().regex(/audition-feedback@\d+$/),
  project: z.string().optional(),
  patchDir: z.string().optional(),
  listened: z.boolean().optional(),
  items: z.array(FeedbackItemSchema),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export interface RatedSound { name: string; family: string; raw: number[]; rating: 'up' | 'down' }

export interface FeedbackVerdicts {
  rows: Verdict[];
  /** Liked sounds with no disliked sound in their family: nothing to compare them with. */
  unpaired: string[];
}

export function verdictsFromFeedback(rated: RatedSound[], base: { project: string; session: string; at: string }): FeedbackVerdicts {
  const { x } = tasteVectors(rated.map(r => r.raw));
  const side = (i: number) => ({ name: rated[i].name, family: rated[i].family, x: x[i] });
  const head = { schema: 'beeps/verdict@1' as const, ...base };
  const rows: Verdict[] = [];
  const unpaired: string[] = [];
  const families = [...new Set(rated.map(r => r.family))];
  for (const family of families) {
    const idx = rated.map((r, i) => (r.family === family ? i : -1)).filter(i => i >= 0);
    const ups = idx.filter(i => rated[i].rating === 'up');
    const downs = idx.filter(i => rated[i].rating === 'down');
    for (const u of ups) for (const d of downs) rows.push({ ...head, kind: 'implied', winner: side(u), loser: side(d), weight: 1 / 3, tags: ['feedback'] });
    if (!ups.length) for (const d of downs) rows.push({ ...head, kind: 'bothBad', loser: side(d), weight: 0.5, tags: ['feedback'] });
    if (!downs.length) for (const u of ups) unpaired.push(rated[u].name);
  }
  return { rows, unpaired };
}
