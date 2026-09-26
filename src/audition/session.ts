// Audition sessions: candidates, a sealed prediction, and an append-only event log folded into state.
// Only explicit judgements (lineup ♥/✗, duels, ship) become verdicts; plays are engagement only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BeepsError } from '../errors.ts';
import { featureVector, FEATURE_NAMES, type Features } from '../measure/index.ts';
import { newId, readSet, setCandidatePatch, type CandidateSet } from '../sets.ts';
import { savePatch, type OpenProject } from '../project.ts';
import { addToKit, readKit, writeKit } from '../kit.ts';
import { appendVerdicts, beepsHome, globalVerdictsFile, readVerdicts, type Verdict } from '../taste/verdicts.ts';
import { fitLayered, type Model } from '../taste/model.ts';
import { rank } from '../taste/select.ts';

/** Typical spread of each taste feature across game SFX; differences are expressed in these units. */
export const FEATURE_SCALES = [0.4, 0.5, 1.0, 0.5, 0.15, 0.2, 0.2, 0.25, 0.5, 0.5, 1.0];
if (FEATURE_SCALES.length !== FEATURE_NAMES.length) throw new Error('FEATURE_SCALES out of sync with FEATURE_NAMES');

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'plain lowercase id');

export const SessionCandidate = z.object({
  index: z.number().int().positive(),
  name: Id,
  setId: Id,
  key: z.string(),
  seed: z.number().int().default(1),
  trimDb: z.number(),
  round: z.number().int().min(0),
  raw: z.array(z.number()),
  features: z.record(z.string(), z.unknown()),
  look: z.string(),
});
export type SessionCandidate = z.infer<typeof SessionCandidate>;

export const SessionSchema = z.object({
  schema: z.literal('beeps/session@1'),
  id: z.string(),
  setId: z.string(),
  project: z.string(),
  family: z.string(),
  archetype: z.string().nullable(),
  prompt: z.string(),
  mode: z.enum(['live', 'handoff']),
  context: z.object({ kit: z.boolean(), bed: z.boolean() }),
  createdAt: z.string(),
  candidates: z.array(SessionCandidate),
});
export type Session = z.infer<typeof SessionSchema>;

export const PredictionSchema = z.object({
  pick: z.number().int().positive(),
  shortlist: z.array(z.number().int().positive()).default([]),
  why: z.string().default(''),
  at: z.string(),
});
export type Prediction = z.infer<typeof PredictionSchema>;

const Dir = z.enum(['brighter', 'darker', 'punchier', 'softer', 'shorter', 'longer', 'less-harsh', 'more-character', 'surprise']);
export const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play'), index: z.number().int(), mode: z.string().max(20) }),
  z.object({ type: z.literal('lineup'), loved: z.array(z.number().int()), duds: z.array(z.number().int()) }),
  z.object({ type: z.literal('duel'), a: z.number().int(), b: z.number().int(), outcome: z.enum(['a', 'b', 'tie', 'bothBad']), tags: z.array(z.string().max(30)).max(8).default([]), position: z.enum(['ab', 'ba']).default('ab') }),
  z.object({ type: z.literal('refine'), champion: z.number().int(), directions: z.array(Dir).max(4).default([]), like: z.number().int().nullable().default(null) }),
  z.object({ type: z.literal('round'), n: z.number().int().positive(), setId: Id, candidates: z.array(SessionCandidate).min(1) }),
  z.object({ type: z.literal('refineFailed'), message: z.string().max(500) }),
  z.object({ type: z.literal('ship'), champion: z.number().int(), name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional() }),
  z.object({ type: z.literal('abandon') }),
]);
export type AuditionEvent = z.infer<typeof EventSchema>;
/** Events the owner's page may send; rounds and failures come only from the agent's CLI or the server. */
export const CLIENT_EVENTS = new Set(['play', 'lineup', 'duel', 'refine', 'ship', 'abandon']);
export type StoredEvent = AuditionEvent & { at: string; seq: number };

export const sessionDir = (p: OpenProject, id: string) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new BeepsError('E_NOT_FOUND', `invalid session id "${id}"`);
  return join(p.paths.sessions, id);
};

/** Taste vectors: feature vector centred on the session's family mean, in FEATURE_SCALES units. */
export function tasteVectors(raws: number[][]): { x: number[][]; mean: number[] } {
  const mean = FEATURE_NAMES.map((_, i) => raws.reduce((s, r) => s + r[i], 0) / Math.max(1, raws.length));
  return { mean, x: raws.map(r => r.map((v, i) => (v - mean[i]) / FEATURE_SCALES[i])) };
}

/** Global taste from other projects, plus this project's layer, so project rows are not counted twice. */
export function loadModel(p: OpenProject): Model {
  const global = readVerdicts(globalVerdictsFile()).rows.filter(r => r.project !== p.paths.root);
  return fitLayered(global, readVerdicts(join(p.paths.taste, 'verdicts.jsonl')).rows);
}

export function candidatesFromSet(set: CandidateSet, round: number, startIndex: number): SessionCandidate[] {
  return set.candidates.map((c, i) => SessionCandidate.parse({
    index: startIndex + i, name: c.name, setId: set.id, key: c.key, seed: c.seed, trimDb: c.trimDb, round,
    raw: featureVector(c.features as unknown as Features), features: c.features, look: c.look,
  }));
}

export function writePrediction(p: OpenProject, setId: string, pred: Omit<Prediction, 'at'>): Prediction {
  const set = readSet(p, setId);
  const valid = new Set(set.candidates.map(c => c.index));
  for (const i of [pred.pick, ...(pred.shortlist ?? [])]) if (!valid.has(i)) throw new BeepsError('E_SCHEMA', `candidate ${i} is not in set ${setId}`, { hint: `indexes are ${[...valid].join(', ')}` });
  const full = PredictionSchema.parse({ ...pred, at: new Date().toISOString() });
  writeFileSync(join(p.paths.sets, setId, 'prediction.json'), JSON.stringify(full, null, 2) + '\n');
  return full;
}

export function openSession(p: OpenProject, setId: string, opts: { prompt?: string; mode?: 'live' | 'handoff'; context?: { kit: boolean; bed: boolean }; requirePrediction?: boolean }): Session {
  const set = readSet(p, setId);
  const predFile = join(p.paths.sets, setId, 'prediction.json');
  const agent = existsSync(predFile) ? PredictionSchema.parse(JSON.parse(readFileSync(predFile, 'utf8'))) : null;
  if (!agent && opts.requirePrediction !== false) {
    throw new BeepsError('E_PREDICTION_REQUIRED', `record your prediction for set ${setId} before opening the audition`, { hint: `beeps predict --set ${setId} --pick <n> --shortlist <a,b> --why "..."  (or pass --no-predict, which is recorded)` });
  }
  const candidates = candidatesFromSet(set, 0, 1);
  const session = SessionSchema.parse({
    schema: 'beeps/session@1', id: newId(set.archetype ?? set.family), setId, project: p.paths.root,
    family: set.family, archetype: set.archetype, prompt: opts.prompt ?? set.prompt ?? '',
    mode: opts.mode ?? 'live', context: opts.context ?? { kit: true, bed: false },
    createdAt: new Date().toISOString(), candidates,
  });
  const dir = sessionDir(p, session.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2) + '\n');
  // Sealed until ship: the server never serves prediction.json before the owner commits.
  const model = loadModel(p);
  const ranked = rank(tasteVectors(candidates.map(c => c.raw)).x.map((x, i) => ({ index: candidates[i].index, x })), model);
  writeFileSync(join(dir, 'prediction.json'), JSON.stringify({
    // With no judgements yet every utility is zero: record no pick rather than an arbitrary one.
    agent, model: { pick: model.n ? ranked[0].index : null, shortlist: model.n ? ranked.slice(0, 3).map(r => r.index) : [], verdicts: model.n, ranking: ranked },
  }, null, 2) + '\n');
  writeFileSync(join(dir, 'events.jsonl'), '');
  return session;
}

export function readSession(p: OpenProject, id: string): Session {
  const file = join(sessionDir(p, id), 'session.json');
  if (!existsSync(file)) throw new BeepsError('E_NOT_FOUND', `no session "${id}"`);
  return SessionSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function readEvents(p: OpenProject, id: string): StoredEvent[] {
  const file = join(sessionDir(p, id), 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as StoredEvent]; } catch { return []; }
  });
}

export interface SessionState {
  stage: 'lineup' | 'duel' | 'refine' | 'waiting' | 'shipped' | 'abandoned';
  round: number;
  candidates: SessionCandidate[];
  /** Candidates on offer in the current round's lineup (the champion is pinned after round 0). */
  lineup: number[];
  loved: number[];
  duds: number[];
  shortlist: number[];
  duels: { a: number; b: number; outcome: string }[];
  champion: number | null;
  pendingRefine: { directions: string[]; like: number | null; champion: number } | null;
  lastError: string | null;
  shipped: number | null;
  events: number;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export function foldSession(session: Session, events: StoredEvent[]): SessionState {
  const s: SessionState = {
    stage: 'lineup', round: 0, candidates: [...session.candidates], lineup: session.candidates.map(c => c.index),
    loved: [], duds: [], shortlist: [], duels: [], champion: null, pendingRefine: null, lastError: null, shipped: null, events: events.length,
  };
  const score = new Map<number, number>();
  const championOf = () => {
    if (!s.shortlist.length) return null;
    return [...s.shortlist].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || s.shortlist.indexOf(a) - s.shortlist.indexOf(b))[0];
  };
  const pairsLeft = () => {
    const asked = new Set(s.duels.map(d => pairKey(d.a, d.b)));
    for (let i = 0; i < s.shortlist.length; i++) for (let j = i + 1; j < s.shortlist.length; j++) if (!asked.has(pairKey(s.shortlist[i], s.shortlist[j]))) return true;
    return false;
  };
  for (const e of events) {
    if (s.stage === 'shipped' || s.stage === 'abandoned') break;
    if (e.type === 'lineup') {
      s.loved = e.loved.filter(i => s.lineup.includes(i));
      s.duds = e.duds.filter(i => s.lineup.includes(i));
      const pinned = s.round > 0 && s.champion !== null ? [s.champion] : [];
      const liked = s.loved.length ? s.loved : s.lineup.filter(i => !s.duds.includes(i) && !pinned.includes(i));
      s.shortlist = [...new Set([...pinned, ...liked])];
      s.duels = [];
      score.clear();
      s.champion = championOf();
      s.stage = pairsLeft() ? 'duel' : 'refine';
    } else if (e.type === 'duel') {
      s.duels.push({ a: e.a, b: e.b, outcome: e.outcome });
      if (e.outcome === 'a') { score.set(e.a, (score.get(e.a) ?? 0) + 1); score.set(e.b, (score.get(e.b) ?? 0) - 1); }
      if (e.outcome === 'b') { score.set(e.b, (score.get(e.b) ?? 0) + 1); score.set(e.a, (score.get(e.a) ?? 0) - 1); }
      if (e.outcome === 'bothBad') { score.set(e.a, (score.get(e.a) ?? 0) - 1); score.set(e.b, (score.get(e.b) ?? 0) - 1); }
      s.champion = championOf();
      if (!pairsLeft()) s.stage = 'refine';
    } else if (e.type === 'refine') {
      s.pendingRefine = { directions: e.directions, like: e.like, champion: e.champion };
      s.champion = e.champion;
      s.lastError = null;
      s.stage = 'waiting';
    } else if (e.type === 'refineFailed') {
      s.pendingRefine = null;
      s.lastError = e.message;
      s.stage = 'refine';
    } else if (e.type === 'round') {
      s.round = e.n;
      s.candidates.push(...e.candidates);
      s.lineup = [...(s.champion !== null ? [s.champion] : []), ...e.candidates.map(c => c.index)];
      s.loved = []; s.duds = []; s.shortlist = []; s.duels = [];
      s.pendingRefine = null;
      s.stage = 'lineup';
    } else if (e.type === 'ship') {
      s.shipped = e.champion; s.champion = e.champion; s.stage = 'shipped';
    } else if (e.type === 'abandon') {
      s.stage = 'abandoned';
    }
  }
  return s;
}

/** Verdict rows implied by one event, given the state before it. */
export function verdictsFor(session: Session, before: SessionState, e: AuditionEvent): Verdict[] {
  const all = before.candidates.concat(e.type === 'round' ? e.candidates : []);
  const { x } = tasteVectors(all.map(c => c.raw));
  const side = (index: number) => {
    const i = all.findIndex(c => c.index === index);
    return i < 0 ? null : { name: all[i].name, family: session.family, x: x[i] };
  };
  const base = { schema: 'beeps/verdict@1' as const, at: new Date().toISOString(), project: session.project, session: session.id };
  const rows: Verdict[] = [];
  if (e.type === 'lineup') {
    for (const l of e.loved) for (const d of e.duds) {
      const w = side(l), lo = side(d);
      if (w && lo) rows.push({ ...base, kind: 'implied', winner: w, loser: lo, weight: 1 / 3, tags: [] });
    }
  } else if (e.type === 'duel') {
    const a = side(e.a), b = side(e.b);
    if (!a || !b) return rows;
    if (e.outcome === 'tie') rows.push({ ...base, kind: 'tie', a, b, weight: 0.5, tags: e.tags });
    else if (e.outcome === 'bothBad') rows.push({ ...base, kind: 'bothBad', loser: a, weight: 0.5, tags: e.tags }, { ...base, kind: 'bothBad', loser: b, weight: 0.5, tags: e.tags });
    else rows.push({ ...base, kind: 'duel', winner: e.outcome === 'a' ? a : b, loser: e.outcome === 'a' ? b : a, weight: 1, tags: e.tags });
  }
  return rows;
}

const conflict = (message: string) => new BeepsError('E_CONFLICT', message);

/**
 * The transition table: which event is accepted in which stage, with normalised lineup marks.
 * Returns the event to store (lineup marks deduped and restricted to what is on offer).
 */
export function checkTransition(before: SessionState, e: AuditionEvent): AuditionEvent {
  const stage = before.stage;
  const known = new Set(before.candidates.map(c => c.index));
  const need = (ok: boolean, what: string) => { if (!ok) throw conflict(`${what} is not accepted in the ${stage} stage`); };
  const exists = (i: number) => { if (!known.has(i)) throw new BeepsError('E_SCHEMA', `candidate ${i} is not in session`); };
  // Unknown candidates are malformed requests (400) whatever the stage.
  const refs = e.type === 'lineup' ? [...e.loved, ...e.duds] : e.type === 'duel' ? [e.a, e.b] : e.type === 'refine' || e.type === 'ship' ? [e.champion] : e.type === 'play' ? [e.index] : [];
  refs.forEach(exists);
  switch (e.type) {
    case 'play': exists(e.index); return e;
    case 'abandon': return e;
    case 'lineup': {
      need(stage === 'lineup', 'lineup');
      const loved = [...new Set(e.loved)], duds = [...new Set(e.duds)];
      [...loved, ...duds].forEach(exists);
      for (const i of [...loved, ...duds]) if (!before.lineup.includes(i)) throw new BeepsError('E_SCHEMA', `candidate ${i} is not on offer in this round`);
      const both = loved.filter(i => duds.includes(i));
      if (both.length) throw new BeepsError('E_SCHEMA', `candidate ${both.join(', ')} is marked both keep and dud`);
      const pinned = before.round > 0 && before.champion !== null ? [before.champion] : [];
      const kept = loved.length ? loved : before.lineup.filter(i => !duds.includes(i) && !pinned.includes(i));
      if (!pinned.length && kept.length === 0) throw new BeepsError('E_SCHEMA', 'keep at least one sound, or close the audition if none of them work');
      return { type: 'lineup', loved, duds };
    }
    case 'duel': {
      need(stage === 'duel', 'duel');
      if (e.a === e.b) throw new BeepsError('E_SCHEMA', 'a sound cannot duel itself');
      for (const i of [e.a, e.b]) if (!before.shortlist.includes(i)) throw new BeepsError('E_SCHEMA', `candidate ${i} is not on the shortlist`);
      if (before.duels.some(d => pairKey(d.a, d.b) === pairKey(e.a, e.b))) throw conflict(`${e.a} and ${e.b} have already been compared`);
      return e;
    }
    case 'refine':
      need(stage === 'duel' || stage === 'refine', 'refine');
      if (e.champion !== before.champion && !before.shortlist.includes(e.champion)) throw new BeepsError('E_SCHEMA', `candidate ${e.champion} is not the champion or on the shortlist`);
      if (e.like !== null) exists(e.like);
      return e;
    case 'refineFailed':
      need(stage === 'waiting', 'refineFailed');
      return e;
    case 'round':
      need(stage === 'waiting', 'round (a round is only accepted while waiting)');
      if (e.n !== before.round + 1) throw conflict(`round ${e.n} does not follow round ${before.round}`);
      for (const c of e.candidates) if (known.has(c.index)) throw conflict(`candidate index ${c.index} already exists`);
      return e;
    case 'ship':
      // Shipping while a refine round is still breeding is fine: the owner has heard enough.
      need(stage === 'duel' || stage === 'refine' || stage === 'waiting', 'ship');
      if (e.champion !== before.champion && !before.shortlist.includes(e.champion)) throw new BeepsError('E_SCHEMA', `candidate ${e.champion} is not the champion or on the shortlist`);
      return e;
  }
}

/** Serialise writers (the CLI and the server may append at once) with a lock directory. */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, '.lock');
  const until = Date.now() + 5000;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try { mkdirSync(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 10000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* raced */ }
      if (Date.now() > until) throw new BeepsError('E_SERVER', `session is locked (${lock}); remove it if no beeps process is running`);
      Atomics.wait(nap, 0, 0, 20);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Append one JSON line, first terminating a torn last line left by a crash. */
function appendLine(file: string, line: string) {
  let prefix = '';
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.length && !text.endsWith('\n')) prefix = '\n';
  }
  appendFileSync(file, prefix + line + '\n');
}

/** Validate against the stage, append, and write any verdicts. Returns the stored event and the new state. */
export function appendEvent(p: OpenProject, id: string, raw: unknown): { event: StoredEvent; state: SessionState; verdicts: number } {
  const parsed = EventSchema.safeParse(raw);
  if (!parsed.success) throw new BeepsError('E_SCHEMA', `invalid event: ${parsed.error.issues[0].message}`, { pointer: '/' + parsed.error.issues[0].path.join('/') });
  const dir = sessionDir(p, id);
  return withLock(dir, () => {
    const session = readSession(p, id);
    const events = readEvents(p, id);
    const before = foldSession(session, events);
    if (before.stage === 'shipped' || before.stage === 'abandoned') throw conflict(`session ${id} is ${before.stage}`);
    const e = checkTransition(before, parsed.data);
    // Ship writes the patch and kit first: a conflict or missing file leaves the session untouched.
    if (e.type === 'ship') shipChampion(p, before, e.champion, e.name);
    const seq = events.reduce((m, x) => Math.max(m, x.seq ?? 0), 0) + 1;
    const stored = { ...e, at: new Date().toISOString(), seq } as StoredEvent;
    appendLine(join(dir, 'events.jsonl'), JSON.stringify(stored));
    const rows = verdictsFor(session, before, e);
    appendVerdicts([join(p.paths.taste, 'verdicts.jsonl'), globalVerdictsFile()], rows);
    const state = foldSession(session, [...events, stored]);
    if (e.type === 'ship') recordReveal(p, session, e.champion);
    return { event: stored, state, verdicts: rows.length };
  });
}

export interface Reveal {
  champion: number;
  agent: { pick: number; shortlist: number[]; why: string; hit: boolean; shortlistHit: boolean } | null;
  model: { pick: number | null; hit: boolean; verdicts: number };
}

export function readReveal(p: OpenProject, id: string): Reveal | null {
  const file = join(sessionDir(p, id), 'reveal.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function recordReveal(p: OpenProject, session: Session, champion: number): Reveal {
  const predFile = join(sessionDir(p, session.id), 'prediction.json');
  const pred = existsSync(predFile) ? JSON.parse(readFileSync(predFile, 'utf8')) : { agent: null, model: { pick: null, verdicts: 0 } };
  // Predictions were made on round 0: a champion bred in a later round is "a mutation of" its ancestor.
  const reveal: Reveal = {
    champion,
    agent: pred.agent ? {
      pick: pred.agent.pick, shortlist: pred.agent.shortlist, why: pred.agent.why,
      hit: pred.agent.pick === champion, shortlistHit: pred.agent.shortlist.includes(champion) || pred.agent.pick === champion,
    } : null,
    model: { pick: pred.model.pick ?? null, hit: pred.model.pick != null && pred.model.pick === champion, verdicts: pred.model.verdicts ?? 0 },
  };
  writeFileSync(join(sessionDir(p, session.id), 'reveal.json'), JSON.stringify(reveal, null, 2) + '\n');
  const log = join(beepsHome(), 'taste', 'predictions.jsonl');
  mkdirSync(join(beepsHome(), 'taste'), { recursive: true });
  appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), project: session.project, session: session.id, family: session.family, ...reveal }) + '\n');
  return reveal;
}

export interface Stats { sessions: number; agent: { predicted: number; hits: number; shortlistHits: number; rate: number | null }; model: { hits: number; rate: number | null }; recent: { window: number; agentRate: number | null; modelRate: number | null } }

export function predictionStats({ project, window = 10 }: { project?: string; window?: number } = {}): Stats {
  const log = join(beepsHome(), 'taste', 'predictions.jsonl');
  const rows = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  const mine = rows.filter(r => !project || r.project === project);
  const rate = (xs: boolean[]) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 1000 : null);
  const agentRows = mine.filter(r => r.agent);
  const recent = mine.slice(-window);
  return {
    sessions: mine.length,
    agent: { predicted: agentRows.length, hits: agentRows.filter(r => r.agent.hit).length, shortlistHits: agentRows.filter(r => r.agent.shortlistHit).length, rate: rate(agentRows.map(r => r.agent.hit)) },
    model: { hits: mine.filter(r => r.model.hit).length, rate: rate(mine.filter(r => r.model.pick != null).map(r => r.model.hit)) },
    recent: { window, agentRate: rate(recent.filter(r => r.agent).map(r => r.agent.hit)), modelRate: rate(recent.filter(r => r.model.pick != null).map(r => r.model.hit)) },
  };
}

/**
 * Save the shipped candidate as a project patch and add it to the kit at the loudness trim and seed
 * it was auditioned with. Refuses to replace a different patch that already has the name.
 */
function shipChampion(p: OpenProject, state: SessionState, index: number, name?: string): void {
  const c = state.candidates.find(x => x.index === index);
  if (!c) throw new BeepsError('E_NOT_FOUND', `candidate ${index} is not in this session`);
  const patch = { ...setCandidatePatch(p, c.setId, c.name), ...(name ? { name } : {}) };
  const file = join(p.paths.patches, `${patch.name}.json`);
  if (existsSync(file) && readFileSync(file, 'utf8') !== JSON.stringify(patch, null, 2) + '\n') {
    throw conflict(`a different patch named "${patch.name}" already exists; ship under another name`);
  }
  savePatch(p, patch, { force: true });
  writeKit(p.paths.root, addToKit(readKit(p.paths.root), { name: patch.name, family: patch.family, priority: patch.meta?.priority ?? 3, trimDb: c.trimDb, seed: c.seed }));
}
