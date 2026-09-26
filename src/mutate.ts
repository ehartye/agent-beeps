// Refine by ear: nudge parameters (jsfxr/bfxr style: each numeric parameter has a 50 % chance of a
// small nudge; waveforms and structure never change), render, and keep the mutations that move the
// measured features in the direction the owner asked for, favouring what their taste model likes.
import { mulberry32 } from '../runtime/engine/rng.js';
import { noteToHz } from '../runtime/engine/notes.js';
import { getArchetype, type Archetype } from './archetypes.ts';
import { featureVector } from './measure/index.ts';
import type { OpenProject } from './project.ts';
import { openRenderHost, type RenderHost } from './render/host.ts';
import { renderAndMeasure, type Rendered } from './render/pipeline.ts';
import { parsePatch, type Patch } from './schema/patch.ts';
import { finishSet, usable } from './generate.ts';
import type { CandidateSet } from './sets.ts';
import { appendEvent, candidatesFromSet, FEATURE_SCALES, foldSession, loadModel, readEvents, readSession, type SessionState } from './audition/session.ts';
import { setCandidatePatch, readSet } from './sets.ts';
import { utility } from './taste/model.ts';

export { DIRECTIONS, directionScore } from './directions.ts';
import { directionScore } from './directions.ts';

const FROZEN = new Set(['schema', 'start', 'variants', 'priority', 'algorithm', 'weights', 'at', 'voices']);
const DB_KEYS = new Set(['gainDb', 'sendDb', 'resonanceDb']);
const UNIT_KEYS = new Set(['sustain', 'drive', 'feedback', 'pan']);

type Leaf = { path: (string | number)[]; value: number | string };

function leaves(obj: unknown, path: (string | number)[] = [], out: Leaf[] = []): Leaf[] {
  if (Array.isArray(obj)) obj.forEach((v, i) => leaves(v, [...path, i], out));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (FROZEN.has(k) || k === 'variation' || k === 'meta') continue;
      leaves(v, [...path, k], out);
    }
  } else if (typeof obj === 'number' || (typeof obj === 'string' && (path.at(-1) === 'pitch' || path.at(-1) === 'to'))) {
    out.push({ path, value: obj });
  }
  return out;
}

const pointer = (path: (string | number)[]) => '/' + path.join('/');

function setAt(obj: any, path: (string | number)[], value: unknown) {
  let cur = obj;
  for (const k of path.slice(0, -1)) cur = cur[k];
  cur[path[path.length - 1]] = value;
}

/** One mutation of `patch`; stays schema-valid and within archetype ranges when known. */
export function perturb(patch: Patch, rand: () => number, archetype?: Archetype): Patch {
  for (let attempt = 0; attempt < 20; attempt++) {
    const out = structuredClone(patch) as any;
    let changed = 0;
    for (const leaf of leaves(patch)) {
      if (rand() >= 0.5) continue;
      const u = rand() * 2 - 1;
      const key = String(leaf.path.at(-1));
      const range = archetype?.ranges[pointer(leaf.path)];
      let v = typeof leaf.value === 'string' ? noteToHz(leaf.value) : leaf.value;
      if (range && 'min' in range && !('ratioOf' in range)) {
        if (range.scale === 'log' && range.min > 0) v = Math.exp(Math.log(Math.max(range.min, v)) + u * 0.05 * Math.log(range.max / range.min));
        else v += u * 0.05 * (range.max - range.min);
        v = Math.min(range.max, Math.max(range.min, v));
      } else if (DB_KEYS.has(key)) v += u * 1.5;
      else if (UNIT_KEYS.has(key)) v = Math.min(1, Math.max(key === 'pan' ? -1 : 0, v + u * 0.05));
      else if (v !== 0) v *= 2 ** (u * 0.15);
      else continue;
      setAt(out, leaf.path, Math.round(v * 1e5) / 1e5);
      changed++;
    }
    if (!changed) continue;
    const r = parsePatch(out);
    if (r.ok) return r.patch;
  }
  return patch;
}

/** Interpolate shared numeric leaves (log-space for frequencies and times); structure from `a`. */
export function crossover(a: Patch, b: Patch, t: number): Patch {
  const out = structuredClone(a) as any;
  const bLeaves = new Map(leaves(b).map(l => [pointer(l.path), l.value]));
  for (const leaf of leaves(a)) {
    const other = bLeaves.get(pointer(leaf.path));
    if (other === undefined) continue;
    const x = typeof leaf.value === 'string' ? noteToHz(leaf.value) : leaf.value;
    const y = typeof other === 'string' ? noteToHz(other) : other;
    const logish = x > 0 && y > 0 && !DB_KEYS.has(String(leaf.path.at(-1))) && !UNIT_KEYS.has(String(leaf.path.at(-1)));
    setAt(out, leaf.path, logish ? Math.exp((1 - t) * Math.log(x) + t * Math.log(y)) : (1 - t) * x + t * y);
  }
  const r = parsePatch(out);
  return r.ok ? r.patch : a;
}


export async function mutate(host: RenderHost, p: OpenProject, opts: { parent: Patch; toward?: string[]; like?: Patch; count?: number; seed?: number; parentSet?: string | null; prompt?: string | null }): Promise<CandidateSet> {
  const count = opts.count ?? 4;
  const seed = opts.seed ?? Math.floor(Math.random() * 1e6);
  const rand = mulberry32(seed);
  const archetype = opts.parent.archetype ? (() => { try { return getArchetype(opts.parent.archetype!); } catch { return undefined; } })() : undefined;
  const toward = (opts.toward ?? []).filter(d => d !== 'surprise');
  const base = (opts.parent.archetype ?? opts.parent.family).slice(0, 24);
  const tag = (seed % 0xffff).toString(16);
  const kids: Patch[] = [];
  for (let i = 0; i < count * 6; i++) {
    let child = opts.like ? crossover(opts.parent, opts.like, 0.25 + 0.5 * rand()) : opts.parent;
    child = perturb(child, rand, archetype);
    if (JSON.stringify(child.layers) === JSON.stringify(opts.parent.layers)) continue; // unchanged: not a variation
    kids.push({ ...child, name: `${base}-m${tag}-${i + 1}` });
  }
  const [parentR] = await renderAndMeasure(host, [{ patch: opts.parent, seed }], { project: p.project, rendersDir: p.paths.renders });
  const pool = usable(await renderAndMeasure(host, kids.map(patch => ({ patch, seed })), { project: p.project, rendersDir: p.paths.renders }), p);
  const pv = parentR.ok ? featureVector(parentR.features) : null;
  const model = loadModel(p);
  const scored = pool.map(r => {
    const v = featureVector(r.features);
    const dir = pv && toward.length ? directionScore(pv, v, toward) : 0;
    const novelty = pv ? Math.sqrt(v.reduce((s, x, i) => s + ((x - pv[i]) / FEATURE_SCALES[i]) ** 2, 0)) : 0;
    const taste = model.n >= 10 ? utility(model, v.map((x, i) => x / FEATURE_SCALES[i])).u : 0;
    return { r, dir, score: (toward.length ? dir : novelty) + 0.3 * taste };
  }).sort((a, b) => b.score - a.score);
  const keep = scored.slice(0, count);
  const weak = new Set(keep.filter(k => toward.length && k.dir <= 0).map(k => k.r.patch.name));
  return finishSet(host, p, keep.map(k => k.r as Rendered), {
    archetype: opts.parent.archetype ?? null, family: opts.parent.family, prompt: opts.prompt ?? null,
    parent: opts.parentSet ?? null, idPrefix: `${base}-mut`, weak,
  });
}

/** Hand-off mode: the server breeds the next round itself when the owner asks to refine. */
export async function autoRefine(p: OpenProject, sessionId: string, state: SessionState): Promise<void> {
  const req = state.pendingRefine;
  if (!req) return;
  const champ = state.candidates.find(c => c.index === req.champion);
  if (!champ) return;
  const likeC = req.like !== null ? state.candidates.find(c => c.index === req.like) : undefined;
  let host: RenderHost | undefined;
  try {
    host = await openRenderHost();
    const set = await mutate(host, p, {
      parent: setCandidatePatch(p, champ.setId, champ.name),
      like: likeC ? setCandidatePatch(p, likeC.setId, likeC.name) : undefined,
      toward: req.directions, count: 4, parentSet: champ.setId,
    });
    if (!set.candidates.length) throw new Error('no mutation passed the craft rules');
    // Re-read the session: the owner may have shipped or closed it while this round was breeding.
    const fresh = foldSession(readSession(p, sessionId), readEvents(p, sessionId));
    if (fresh.stage !== 'waiting') return;
    const start = Math.max(...fresh.candidates.map(c => c.index)) + 1;
    appendEvent(p, sessionId, { type: 'round', n: fresh.round + 1, setId: set.id, candidates: candidatesFromSet(readSet(p, set.id), fresh.round + 1, start) });
  } catch (e) {
    try { appendEvent(p, sessionId, { type: 'refineFailed', message: `could not breed variations: ${(e as Error).message}`.slice(0, 500) }); } catch { /* session moved on */ }
  } finally { await host?.close(); }
}
