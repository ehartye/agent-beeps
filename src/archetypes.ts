// Archetypes: a template patch plus parameter ranges. Sampling one gives seeded, schema-valid
// candidate patches that stay recognisably "a coin" or "a laser" while differing in pitch, decay,
// timbre and filter.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BeepsError } from './errors.ts';
import { parsePatch, type Patch } from './schema/patch.ts';
import { mulberry32 } from '../runtime/engine/rng.js';
import { noteToHz } from '../runtime/engine/notes.js';

export const ARCHETYPES_DIR = join(import.meta.dirname, '..', 'library', 'archetypes');

const Scale = z.enum(['lin', 'log']).default('lin');
const NumRange = z.strictObject({ min: z.number(), max: z.number(), scale: Scale });
const ChoiceRange = z.strictObject({ choices: z.array(z.unknown()).min(1) });
const RatioSpan = z.strictObject({ ratioOf: z.string(), min: z.number().positive(), max: z.number().positive(), scale: Scale });
const RatioChoice = z.strictObject({ ratioOf: z.string(), choices: z.array(z.number().positive()).min(1) });
const RangeSchema = z.union([NumRange, ChoiceRange, RatioSpan, RatioChoice]);

export type Range = z.output<typeof RangeSchema>;

const ArchetypeFile = z.strictObject({
  schema: z.literal('beeps/archetype@1'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  family: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  template: z.unknown(),
  ranges: z.record(z.string(), RangeSchema),
});

export interface Archetype {
  name: string;
  family: string;
  description: string;
  template: Patch;
  ranges: Record<string, Range>;
}

// ---- JSON pointers (RFC 6901) ----

const decodeToken = (t: string) => t.replaceAll('~1', '/').replaceAll('~0', '~');

function tokens(ptr: string): string[] {
  if (ptr === '') return [];
  if (!ptr.startsWith('/')) throw new BeepsError('E_USAGE', `JSON pointer "${ptr}" must start with "/"`, { pointer: ptr });
  return ptr.slice(1).split('/').map(decodeToken);
}

const hasKey = (obj: unknown, key: string): boolean => {
  if (Array.isArray(obj)) return /^(0|[1-9]\d*)$/.test(key) && Number(key) < obj.length;
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key);
};

/** Value at `ptr`, or undefined when any step is missing. */
export function getPointer(obj: unknown, ptr: string): unknown {
  let cur: any = obj;
  for (const t of tokens(ptr)) {
    if (!hasKey(cur, t)) return undefined;
    cur = cur[Array.isArray(cur) ? Number(t) : t];
  }
  return cur;
}

/** Sets the value at `ptr` in place; the parent must exist (arrays by existing index). */
export function setPointer(obj: unknown, ptr: string, value: unknown): void {
  const ts = tokens(ptr);
  if (!ts.length) throw new BeepsError('E_USAGE', 'cannot set the root of a document', { pointer: ptr });
  let parent: any = obj;
  for (const t of ts.slice(0, -1)) {
    if (!hasKey(parent, t)) throw new BeepsError('E_USAGE', `no value at ${t} on the way to ${ptr}`, { pointer: ptr });
    parent = parent[Array.isArray(parent) ? Number(t) : t];
  }
  const last = ts[ts.length - 1];
  if (Array.isArray(parent)) {
    if (!hasKey(parent, last)) throw new BeepsError('E_USAGE', `no array index ${last} at ${ptr}`, { pointer: ptr });
    parent[Number(last)] = value;
  } else if (parent !== null && typeof parent === 'object') (parent as Record<string, unknown>)[last] = value;
  else throw new BeepsError('E_USAGE', `no object at the parent of ${ptr}`, { pointer: ptr });
}

const resolves = (obj: unknown, ptr: string) => {
  try { return getPointer(obj, ptr) !== undefined; } catch { return false; }
};

// ---- loading ----

function fail(file: string, message: string, pointer?: string): never {
  throw new BeepsError('E_SCHEMA', `${file}${pointer !== undefined ? ` ${pointer}` : ''}: ${message}`, pointer !== undefined ? { pointer } : {});
}

function toHz(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { try { return noteToHz(v); } catch { return undefined; } }
  return undefined;
}

function validate(file: string, raw: unknown): Archetype {
  const r = ArchetypeFile.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    fail(file, issue.message, '/' + issue.path.map(String).join('/'));
  }
  const a = r.data;
  const expected = file.replace(/\.json$/, '');
  if (a.name !== expected) fail(file, `name "${a.name}" does not match the file name`, '/name');
  const parsed = parsePatch(a.template);
  if (!parsed.ok) {
    const i = parsed.issues[0];
    fail(file, `template is not a valid patch: ${i.message}${i.hint ? ` (${i.hint})` : ''}`, '/template' + i.pointer);
  }
  const template = parsed.patch;
  if (template.name !== a.name) fail(file, 'template name must equal the archetype name', '/template/name');
  if (template.family !== a.family) fail(file, 'template family must equal the archetype family', '/template/family');
  if (template.archetype !== a.name) fail(file, 'template archetype must equal the archetype name', '/template/archetype');

  const seen = new Set<string>();
  for (const [ptr, range] of Object.entries(a.ranges)) {
    if (!resolves(template, ptr)) fail(file, 'range pointer does not resolve in the template', ptr);
    if ('min' in range && range.min > range.max) fail(file, `min ${range.min} exceeds max ${range.max}`, ptr);
    if ('min' in range && range.scale === 'log' && !(range.min > 0)) fail(file, 'log scale needs min > 0', ptr);
    if ('ratioOf' in range) {
      const target = range.ratioOf;
      if (target === ptr) fail(file, 'ratioOf cannot refer to itself', ptr);
      if (!resolves(template, target)) fail(file, `ratioOf target ${target} does not resolve in the template`, ptr);
      if (Object.hasOwn(a.ranges, target) && !seen.has(target)) fail(file, `ratioOf target ${target} must come before its dependents`, ptr);
      if (toHz(getPointer(template, target)) === undefined) fail(file, `ratioOf target ${target} is not a number or note name`, ptr);
    }
    seen.add(ptr);
  }
  return { name: a.name, family: a.family, description: a.description, template, ranges: a.ranges };
}

export function loadArchetypes(dir: string = ARCHETYPES_DIR): Archetype[] {
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch {
    throw new BeepsError('E_NOT_FOUND', `archetype directory ${dir} is missing`);
  }
  return files.map(f => {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch (e) {
      fail(f, `not valid JSON: ${(e as Error).message}`);
    }
    return validate(f, raw);
  }).sort((x, y) => x.name.localeCompare(y.name));
}

export function getArchetype(name: string, dir: string = ARCHETYPES_DIR): Archetype {
  const all = loadArchetypes(dir);
  const a = all.find(x => x.name === name);
  if (!a) throw new BeepsError('E_NOT_FOUND', `no archetype named "${name}"`, { hint: `one of: ${all.map(x => x.name).join(', ')}` });
  return a;
}

// ---- sampling ----

const precise = (x: number) => Number(x.toPrecision(5));

function draw(rand: () => number, r: { min: number; max: number; scale: 'lin' | 'log' }): number {
  const u = rand();
  const v = r.scale === 'log' ? Math.exp(Math.log(r.min) + u * (Math.log(r.max) - Math.log(r.min))) : r.min + u * (r.max - r.min);
  return Math.min(r.max, Math.max(r.min, v));
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];

function applyRanges(a: Archetype, rand: () => number): Patch {
  const p = structuredClone(a.template);
  for (const [ptr, range] of Object.entries(a.ranges)) {
    let value: unknown;
    if ('ratioOf' in range) {
      const base = toHz(getPointer(p, range.ratioOf))!;
      const ratio = 'choices' in range ? pick(rand, range.choices) : draw(rand, range);
      value = precise(base * ratio);
    } else if ('choices' in range) value = structuredClone(pick(rand, range.choices));
    else value = Math.min(range.max, Math.max(range.min, precise(draw(rand, range))));
    setPointer(p, ptr, value);
  }
  return p;
}

/**
 * `count` patches sampled from the archetype's ranges, deterministic per seed. Each is a deep clone
 * of the template with every range applied in key order, named `<archetype>-<seed>-<i>`.
 */
export function sampleArchetype(a: Archetype, seed: number, count: number, opts: { namePrefix?: string } = {}): Patch[] {
  if (!Number.isInteger(seed)) throw new BeepsError('E_USAGE', `seed must be an integer, got ${seed}`);
  const rand = mulberry32(seed);
  const prefix = (opts.namePrefix ?? a.name).toLowerCase();
  const out: Patch[] = [];
  for (let i = 0; i < count; i++) {
    let last: string | undefined;
    let ok: Patch | undefined;
    for (let attempt = 0; attempt < 10 && !ok; attempt++) {
      const p = applyRanges(a, rand);
      p.name = `${prefix}-${seed}-${i}`.toLowerCase();
      p.archetype = a.name;
      const r = parsePatch(p);
      if (r.ok) ok = r.patch;
      else last = `${r.issues[0].pointer}: ${r.issues[0].message}`;
    }
    if (!ok) throw new BeepsError('E_SCHEMA', `archetype ${a.name}: sample ${i} of seed ${seed} failed validation 10 times (${last})`, { pointer: last?.split(':')[0] });
    out.push(ok);
  }
  return out;
}
