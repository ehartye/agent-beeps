// Bradley-Terry over feature differences: P(a beats b) = σ(w·(x_a − x_b)).
// Fit by Newton's method with an L2 prior (neutral until data arrives); the inverse Hessian is the
// Laplace covariance, so every utility carries an uncertainty. Ties are logged but not fitted:
// they shrink error bars while biasing differences toward zero.
import { FEATURE_NAMES } from '../measure/index.ts';
import type { Verdict } from './verdicts.ts';

export type { Verdict } from './verdicts.ts';

export const DIM = FEATURE_NAMES.length;
export const PROJECT_LAYER_MIN = 15;

export interface Model { w: number[]; cov: number[][]; n: number; projectLayer?: boolean; nGlobal?: number; nProject?: number }

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

/** (difference vector, weight) pairs where the first side won. */
function pairs(rows: Verdict[]): { d: number[]; w: number }[] {
  const out: { d: number[]; w: number }[] = [];
  const zero = new Array(DIM).fill(0);
  for (const r of rows) {
    if (r.kind === 'tie') continue;
    if (r.kind === 'bothBad') {
      if (r.loser) out.push({ d: zero.map((_, i) => 0 - (r.loser!.x[i] ?? 0)), w: r.weight });
      continue;
    }
    if (r.winner && r.loser) out.push({ d: r.winner.x.map((v, i) => v - (r.loser!.x[i] ?? 0)), w: r.weight });
  }
  return out;
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A is small and SPD). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function invert(A: number[][]): number[][] {
  const n = A.length;
  const cols = Array.from({ length: n }, (_, j) => solve(A, Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))));
  return Array.from({ length: n }, (_, i) => cols.map(col => col[i]));
}

/** Penalised negative log-likelihood. */
function objective(w: number[], data: { d: number[]; w: number }[], lambda: number, p0: number[]): number {
  let f = 0;
  for (const { d, w: wt } of data) {
    const z = dot(w, d);
    f += wt * (z > 0 ? Math.log1p(Math.exp(-z)) : -z + Math.log1p(Math.exp(z)));
  }
  return f + (lambda / 2) * w.reduce((s, v, i) => s + (v - p0[i]) ** 2, 0);
}

export function fitBT(rows: Verdict[], { lambda = 1, prior }: { lambda?: number; prior?: number[] } = {}): Model {
  const p0 = prior ?? new Array(DIM).fill(0);
  const data = pairs(rows);
  let w = [...p0];
  let H: number[][] = [];
  for (let iter = 0; iter < 50; iter++) {
    const g = w.map((v, i) => lambda * (v - p0[i]));
    H = Array.from({ length: DIM }, (_, i) => Array.from({ length: DIM }, (_, j) => (i === j ? lambda : 0)));
    for (const { d, w: wt } of data) {
      const s = sigmoid(dot(w, d));
      for (let i = 0; i < DIM; i++) {
        g[i] -= wt * d[i] * (1 - s);
        for (let j = 0; j < DIM; j++) H[i][j] += wt * s * (1 - s) * d[i] * d[j];
      }
    }
    const step = solve(H, g);
    // Backtracking: undamped Newton overshoots on logistic loss when it starts far away (e.g. from
    // a global prior the project disagrees with), so only accept steps that lower the objective.
    const before = objective(w, data, lambda, p0);
    let t = 1;
    let next = w.map((v, i) => v - step[i]);
    while (objective(next, data, lambda, p0) > before && t > 1e-6) {
      t /= 2;
      next = w.map((v, i) => v - t * step[i]);
    }
    w = next;
    if (Math.max(...step.map(Math.abs)) * t < 1e-8) break;
  }
  // Recompute the Hessian at the optimum for the Laplace covariance.
  H = Array.from({ length: DIM }, (_, i) => Array.from({ length: DIM }, (_, j) => (i === j ? lambda : 0)));
  for (const { d, w: wt } of data) {
    const s = sigmoid(dot(w, d));
    for (let i = 0; i < DIM; i++) for (let j = 0; j < DIM; j++) H[i][j] += wt * s * (1 - s) * d[i] * d[j];
  }
  return { w, cov: invert(H), n: data.length };
}

/** Global taste, plus a project layer (shrunk toward global) once the project has enough verdicts. */
export function fitLayered(globalRows: Verdict[], projectRows: Verdict[]): Model {
  const g = fitBT(globalRows);
  const nProject = pairs(projectRows).length;
  if (nProject < PROJECT_LAYER_MIN) return { ...g, projectLayer: false, nGlobal: g.n, nProject };
  const p = fitBT(projectRows, { lambda: 3, prior: g.w });
  return { ...p, projectLayer: true, nGlobal: g.n, nProject };
}

export function utility(m: Model, x: number[]): { u: number; sigma: number } {
  const u = dot(m.w, x);
  const cx = m.cov.map(row => dot(row, x));
  return { u, sigma: Math.sqrt(Math.max(0, dot(x, cx))) };
}

export const pWin = (m: Model, a: number[], b: number[]) => sigmoid(dot(m.w, a.map((v, i) => v - b[i])));

/** Standard error of each weight. */
export const standardErrors = (m: Model) => m.cov.map((row, i) => Math.sqrt(Math.max(0, row[i])));
