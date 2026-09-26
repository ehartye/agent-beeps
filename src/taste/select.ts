// Active pair selection: ask about the pair the model is least sure of. Informative comparisons
// beat sorting-style schedules; a pair already asked (including a tie) is not asked again.
import { pWin, utility, type Model } from './model.ts';

export interface Candidate { index: number; x: number[] }
export interface Asked { a: number; b: number; outcome: string }

const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** The next pair [i, j] to duel, or [] when every pair has been asked. */
export function nextDuel(cands: Candidate[], m: Model, asked: Asked[]): number[] {
  const done = new Set(asked.map(q => key(q.a, q.b)));
  let best: number[] = [];
  let bestScore = -Infinity;
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    const a = cands[i], b = cands[j];
    if (done.has(key(a.index, b.index))) continue;
    const p = pWin(m, a.x, b.x);
    const sigma = utility(m, a.x.map((v, k) => v - b.x[k])).sigma;
    const score = (1 - Math.abs(2 * p - 1)) * (1 + sigma);
    if (score > bestScore) { bestScore = score; best = [a.index, b.index]; }
  }
  return best;
}

/** Order candidates by expected utility (for predictions and tie-breaks). */
export function rank(cands: Candidate[], m: Model): { index: number; u: number; sigma: number }[] {
  return cands.map(c => ({ index: c.index, ...utility(m, c.x) })).sort((p, q) => q.u - p.u);
}
