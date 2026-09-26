// Generate a candidate set: oversample an archetype, render and measure everything, drop lint
// failures, then pick a diverse subset by farthest-point selection in taste-feature space.
import { join } from 'node:path';
import { getArchetype, loadArchetypes, sampleArchetype, type Archetype } from './archetypes.ts';
import { lintPatch } from './lint.ts';
import { featureVector } from './measure/index.ts';
import type { OpenProject } from './project.ts';
import type { RenderHost } from './render/host.ts';
import { contactSheet, renderAndMeasure, type Rendered } from './render/pipeline.ts';
import type { Patch } from './schema/patch.ts';
import { candidateFromRendered, newId, writeSet, type CandidateSet } from './sets.ts';
import { loadModel, tasteVectors } from './audition/session.ts';
import { utility } from './taste/model.ts';
import { directionScore, promptDirections } from './directions.ts';

const dist2 = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

/** Greedy max-min selection of k points, seeded with `start` (one index or several). */
export function farthestPoint(points: number[][], k: number, start: number | number[]): number[] {
  if (!points.length) return [];
  const chosen = (Array.isArray(start) ? start : [start]).slice(0, k);
  const nearest = points.map(p => Math.min(...chosen.map(c => dist2(p, points[c]))));
  while (chosen.length < Math.min(k, points.length)) {
    let best = -1;
    for (let i = 0; i < points.length; i++) if (!chosen.includes(i) && (best < 0 || nearest[i] > nearest[best])) best = i;
    chosen.push(best);
    points.forEach((p, i) => { nearest[i] = Math.min(nearest[i], dist2(p, points[best])); });
  }
  return chosen;
}

/** Keep renders that passed and have no error-level lint findings. */
export function usable(rendered: Awaited<ReturnType<typeof renderAndMeasure>>, p: OpenProject): Rendered[] {
  return rendered.flatMap(r => (r.ok && lintPatch(r.patch, r.features, p.project).errors.length === 0 ? [r] : []));
}

/** Choose `count` diverse candidates; start from the taste model's favourite once it has data. */
export function selectDiverse(p: OpenProject, all: Rendered[], count: number, directions: string[] = []): Rendered[] {
  let pool = all;
  if (directions.length && pool.length > count) {
    // Prompt steering: keep the part of the pool that leans the way the request asked, then diversify.
    const raw = pool.map(r => featureVector(r.features));
    const mean = raw[0].map((_, i) => raw.reduce((s, v) => s + v[i], 0) / raw.length);
    const scored = pool.map((r, i) => ({ r, s: directionScore(mean, raw[i], directions) })).sort((a, b) => b.s - a.s);
    pool = scored.slice(0, Math.max(count, Math.ceil(pool.length * 0.5))).map(x => x.r);
  }
  if (pool.length <= count) return pool;
  const { x } = tasteVectors(pool.map(r => featureVector(r.features)));
  const model = loadModel(p);
  let start = 0;
  if (model.n >= 10) start = x.map((v, i) => ({ i, u: utility(model, v).u })).sort((a, b) => b.u - a.u)[0].i;
  else start = x.map((v, i) => ({ i, d: dist2(v, v.map(() => 0)) })).sort((a, b) => a.d - b.d)[0].i; // most typical
  // One typical representative of each structure (archetype) first, so a family set shows every
  // kind of sound it has, then fill for diversity. Farthest-point alone favours the extreme structures.
  const groups = new Map<string, number[]>();
  pool.forEach((r, i) => { const g = r.patch.archetype ?? r.patch.family; groups.set(g, [...(groups.get(g) ?? []), i]); });
  const seeds = groups.size > 1
    ? [start, ...[...groups.values()].filter(ix => !ix.includes(start)).map(ix => ix.sort((a, b) => dist2(x[a], x[a].map(() => 0)) - dist2(x[b], x[b].map(() => 0)))[0])]
    : [start];
  return farthestPoint(x, count, seeds).map(i => pool[i]);
}

export async function finishSet(host: RenderHost, p: OpenProject, chosen: Rendered[], meta: { archetype: string | null; family: string; prompt: string | null; parent: string | null; idPrefix: string; weak?: Set<string> }): Promise<CandidateSet> {
  const id = newId(meta.idPrefix);
  const sheet = join(p.paths.sets, id, 'sheet.png');
  const set = writeSet(p, {
    id, archetype: meta.archetype, family: meta.family, prompt: meta.prompt, parent: meta.parent,
    createdAt: new Date().toISOString(), sheet,
    candidates: chosen.map((r, i) => candidateFromRendered(r, i + 1, meta.weak?.has(r.patch.name))),
  }, chosen.map(r => r.patch as Patch));
  await contactSheet(host, chosen, chosen.map((r, i) => `${i + 1} · ${r.patch.name}${meta.weak?.has(r.patch.name) ? ' (weak)' : ''}`), sheet);
  return set;
}

/** An archetype named after its family ("coin") samples every structure in that family; others only themselves. */
export function familyMembers(a: Archetype): Archetype[] {
  if (a.name !== a.family) return [a];
  return loadArchetypes().filter(x => x.family === a.family);
}

export async function generate(host: RenderHost, p: OpenProject, opts: { archetype: string; count?: number; seed?: number; prompt?: string }): Promise<CandidateSet & { steering: string[] }> {
  const count = opts.count ?? 6;
  const seed = opts.seed ?? Math.floor(Math.random() * 1e6);
  const a = getArchetype(opts.archetype);
  const members = familyMembers(a);
  const per = Math.ceil((count * 4) / members.length);
  const samples = members.flatMap((m, k) => sampleArchetype(m, seed + k * 1009, per));
  const pool = usable(await renderAndMeasure(host, samples.map(patch => ({ patch, seed })), { project: p.project, rendersDir: p.paths.renders }), p);
  const steering = promptDirections(opts.prompt);
  const set = await finishSet(host, p, selectDiverse(p, pool, count, steering), { archetype: a.name, family: a.family, prompt: opts.prompt ?? null, parent: null, idPrefix: a.name });
  return { ...set, steering };
}
