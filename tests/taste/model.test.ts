import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mulberry32 } from '../../runtime/engine/rng.js';
import { FEATURE_NAMES } from '../../src/measure/index.ts';
import { fitBT, fitLayered, pWin, utility, type Verdict } from '../../src/taste/model.ts';
import { appendVerdicts, readVerdicts } from '../../src/taste/verdicts.ts';
import { nextDuel } from '../../src/taste/select.ts';
import { summarize } from '../../src/taste/summary.ts';

const D = FEATURE_NAMES.length;

/** A hidden-weight listener: prefers darker (brightness −), less sharp, shorter; noisy logistic choices. */
function listener(seed: number, truth = [-0.8, 0, -1.2, -1.0, 0, 0, 0, 0, 0, 0, 0]) {
  const rand = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const sample = () => Array.from({ length: D }, gauss);
  const judge = (a: number[], b: number[]): 'a' | 'b' => {
    const d = truth.reduce((s, w, i) => s + w * (a[i] - b[i]), 0);
    return rand() < 1 / (1 + Math.exp(-d)) ? 'a' : 'b';
  };
  return { truth, sample, judge };
}

const duel = (a: number[], b: number[], outcome: 'a' | 'b' | 'tie'): Verdict => outcome === 'tie'
  ? { schema: 'beeps/verdict@1', at: '', project: 'p', session: 's', kind: 'tie', a: { name: 'a', family: 'f', x: a }, b: { name: 'b', family: 'f', x: b }, weight: 1, tags: [] }
  : { schema: 'beeps/verdict@1', at: '', project: 'p', session: 's', kind: 'duel',
      winner: { name: 'w', family: 'f', x: outcome === 'a' ? a : b }, loser: { name: 'l', family: 'f', x: outcome === 'a' ? b : a }, weight: 1, tags: [] };

const corr = (x: number[], y: number[]) => {
  const mx = x.reduce((a, b) => a + b) / x.length, my = y.reduce((a, b) => a + b) / y.length;
  let n = 0, dx = 0, dy = 0;
  x.forEach((v, i) => { n += (v - mx) * (y[i] - my); dx += (v - mx) ** 2; dy += (y[i] - my) ** 2; });
  return n / Math.sqrt(dx * dy);
};

describe('Bradley-Terry taste model', () => {
  it('recovers a simulated listener and predicts held-out duels', () => {
    const L = listener(1);
    const train: Verdict[] = [];
    for (let i = 0; i < 300; i++) { const a = L.sample(), b = L.sample(); train.push(duel(a, b, L.judge(a, b))); }
    const m = fitBT(train);
    expect(corr(m.w, L.truth)).toBeGreaterThan(0.8);
    let right = 0;
    for (let i = 0; i < 400; i++) {
      const a = L.sample(), b = L.sample();
      const truthPrefersA = L.truth.reduce((s, w, k) => s + w * (a[k] - b[k]), 0) > 0;
      if ((pWin(m, a, b) > 0.5) === truthPrefersA) right++;
    }
    expect(right / 400).toBeGreaterThan(0.8);
  });

  it('stays neutral with no data and reports wide uncertainty', () => {
    const m = fitBT([]);
    expect(m.w.every(v => v === 0)).toBe(true);
    expect(utility(m, Array(D).fill(1)).sigma).toBeGreaterThan(0.5);
  });

  it('ignores ties in the fit', () => {
    const L = listener(2);
    const rows: Verdict[] = [];
    for (let i = 0; i < 80; i++) { const a = L.sample(), b = L.sample(); rows.push(duel(a, b, L.judge(a, b))); }
    const base = fitBT(rows);
    const withTies = fitBT([...rows, ...Array.from({ length: 50 }, () => duel(L.sample(), L.sample(), 'tie'))]);
    expect(withTies.w).toEqual(base.w);
  });

  it('shrinks a sparse project layer toward the global taste', () => {
    const G = listener(3);
    const global: Verdict[] = [];
    for (let i = 0; i < 200; i++) { const a = G.sample(), b = G.sample(); global.push(duel(a, b, G.judge(a, b))); }
    const P = listener(4, [0.8, 0, 1.2, 1.0, 0, 0, 0, 0, 0, 0, 0]); // this project wants the opposite
    const few: Verdict[] = [];
    for (let i = 0; i < 10; i++) { const a = P.sample(), b = P.sample(); few.push(duel(a, b, P.judge(a, b))); }
    const sparse = fitLayered(global, few);
    expect(sparse.projectLayer).toBe(false);
    expect(corr(sparse.w, G.truth)).toBeGreaterThan(0.8);
    const many: Verdict[] = [];
    for (let i = 0; i < 150; i++) { const a = P.sample(), b = P.sample(); many.push(duel(a, b, P.judge(a, b))); }
    const rich = fitLayered(global, many);
    expect(rich.projectLayer).toBe(true);
    expect(corr(rich.w, P.truth)).toBeGreaterThan(0.5);
  });
});

describe('active pair selection', () => {
  it('asks about the pair the model is least sure of, and deprioritises tied pairs', () => {
    const m = fitBT([]);
    m.w = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const cands = [
      { index: 1, x: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { index: 2, x: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { index: 3, x: [0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    ];
    expect(nextDuel(cands, m, []).sort()).toEqual([2, 3]);
    const next = nextDuel(cands, m, [{ a: 2, b: 3, outcome: 'tie' }]);
    expect(next.sort()).not.toEqual([2, 3]);
    expect(nextDuel(cands, m, [{ a: 2, b: 3, outcome: 'a' }, { a: 1, b: 2, outcome: 'a' }, { a: 1, b: 3, outcome: 'a' }])).toEqual([]);
  });
});

describe('summary', () => {
  it('names the strongest learned preference in plain words', () => {
    const L = listener(5);
    const rows: Verdict[] = [];
    for (let i = 0; i < 300; i++) { const a = L.sample(), b = L.sample(); rows.push(duel(a, b, L.judge(a, b))); }
    const s = summarize(fitBT(rows), rows.length);
    expect(s.preferences[0].feature).toMatch(/brightness|sharpness/);
    expect(s.preferences[0].confidence).toBe('strong');
    expect(s.markdown).toMatch(/darker|less sharp/);
  });
});

describe('verdict log', () => {
  it('appends rows and tolerates malformed lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-taste-'));
    const file = join(dir, 'verdicts.jsonl');
    const L = listener(6);
    appendVerdicts([file], [duel(L.sample(), L.sample(), 'a')]);
    appendFileSync(file, '{not json\n');
    appendVerdicts([file], [duel(L.sample(), L.sample(), 'b')]);
    const r = readVerdicts(file);
    expect(r.rows).toHaveLength(2);
    expect(r.malformed).toBe(1);
    writeFileSync(join(dir, 'empty.jsonl'), '');
    expect(readVerdicts(join(dir, 'missing.jsonl')).rows).toEqual([]);
  });
});
