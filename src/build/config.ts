// beeps.build.json: where a project's audio recipes, outputs, lock and store are, and how it ships (the delivery preset).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { BeepsError } from '../errors.ts';
import { encoderArgs, FORMATS, type CompressFormat } from '../compress.ts';

export const CONFIG_FILE = 'beeps.build.json';

const Kbps = z.strictObject({ music: z.number().positive(), ambience: z.number().positive(), sfx: z.number().positive(), mix: z.number().positive() });
const Role = z.enum(['sfx', 'music', 'ambience']);

const ConfigSchema = z.strictObject({
  $comment: z.string().optional(),
  /** recipes.json: `{ "<id>": { "source": "sfx/x.json", "role": "sfx" } }` or `[ { "id", "source", "role" } ]`. Sources are relative to this file. */
  recipes: z.string(),
  /** The deliverable directory the game loads (and its index.json catalog). */
  out: z.string(),
  lock: z.string().default('audio.lock.json'),
  /** A beeps/project@1 file (scale and loudness targets). Default: the nearest .agent-beeps/project.json. */
  project: z.string().optional(),
  /** Project patches songs may name as instruments. Default: the project's own patches directory. */
  patches: z.string().optional(),
  /** Scratch space and the local render cache (gitignore it). */
  workDir: z.string().default('.local/audio-build'),
  target: z.string().default('web-universal'),
  /** Per-role bitrate overrides of the target's defaults. */
  kbps: Kbps.partial().optional(),
  budgetBytes: z.number().positive().optional(),
  store: z.string().optional(),
  jobs: z.number().int().min(1).max(8).default(3),
});

export interface BuildConfig {
  file: string; dir: string;
  recipes: string; out: string; lock: string; project?: string; patches?: string; workDir: string;
  target: string; kbps?: Partial<Record<'music' | 'ambience' | 'sfx' | 'mix', number>>; budgetBytes?: number; store?: string; jobs: number;
}

export function loadConfig(startDir: string, file?: string): BuildConfig {
  const path = resolve(file ?? join(startDir, CONFIG_FILE));
  if (!existsSync(path)) throw new BeepsError('E_NOT_FOUND', `no ${CONFIG_FILE} at ${path}`, { hint: 'create it next to the project: { "recipes": "asset-src/audio/recipes.json", "out": "public/audio", "lock": "asset-src/audio/audio.lock.json" } (docs/build-lock-and-store.md)' });
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new BeepsError('E_SCHEMA', `${path}: ${(e as Error).message}`); }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) throw new BeepsError('E_SCHEMA', `${path}: ${r.error.issues[0].message}`, { pointer: '/' + r.error.issues[0].path.join('/') });
  const dir = dirname(path), at = (p?: string) => (p === undefined ? undefined : resolve(dir, p)), c = r.data;
  return { file: path, dir, recipes: resolve(dir, c.recipes), out: resolve(dir, c.out), lock: resolve(dir, c.lock), project: at(c.project), patches: at(c.patches), workDir: resolve(dir, c.workDir), target: c.target, kbps: c.kbps, budgetBytes: c.budgetBytes, store: c.store, jobs: c.jobs };
}

// ---- recipes ----

export interface Recipe {
  id: string; role: z.infer<typeof Role>; kind: 'patch' | 'song';
  /** Absolute path of the patch or song JSON. */
  source: string; sourceRel: string;
  seed: number;
  /** Patches: variants to export (default: the patch's declared count). */
  variants?: number;
}

const RecipeSchema = z.strictObject({ id: z.string().min(1).optional(), source: z.string().min(1), role: Role, kind: z.enum(['patch', 'song']).optional(), seed: z.number().int().optional(), variants: z.number().int().min(1).max(16).optional() });

export function loadRecipes(cfg: BuildConfig): Recipe[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(cfg.recipes, 'utf8')); } catch (e) { throw new BeepsError('E_NOT_FOUND', `cannot read recipes ${cfg.recipes}: ${(e as Error).message}`); }
  const entries: [string | undefined, unknown][] = Array.isArray(raw) ? raw.map(x => [undefined, x]) : Object.entries(raw as object);
  const out = new Map<string, Recipe>();
  const base = dirname(cfg.recipes);
  for (const [key, value] of entries) {
    const r = RecipeSchema.safeParse(value);
    if (!r.success) throw new BeepsError('E_SCHEMA', `recipes ${key ?? ''}: ${r.error.issues[0].message}`, { pointer: `/${key ?? ''}/${r.error.issues[0].path.join('/')}` });
    const id = key ?? r.data.id;
    if (!id) throw new BeepsError('E_SCHEMA', 'a recipe needs an id (the object key, or "id" in an array entry)');
    if (out.has(id)) throw new BeepsError('E_CONFLICT', `recipe "${id}" appears twice`);
    const source = resolve(base, r.data.source);
    if (!existsSync(source)) throw new BeepsError('E_NOT_FOUND', `recipe "${id}": source ${r.data.source} does not exist`, { pointer: `/${id}/source` });
    out.set(id, { id, role: r.data.role, kind: r.data.kind ?? (r.data.role === 'sfx' ? 'patch' : 'song'), source, sourceRel: r.data.source.replaceAll('\\', '/'), seed: r.data.seed ?? 1, ...(r.data.variants ? { variants: r.data.variants } : {}) });
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---- delivery ----

export interface Delivery {
  preset: string;
  format: CompressFormat | 'wav';
  kbps?: { music: number; ambience: number; sfx: number; mix: number };
  /** Encoder arguments with the bitrate left out (it is per role); absent for wav. */
  flags?: string;
}

/**
 * Delivery presets. `web-universal`: Ogg Opus at per-role bitrates (the values Fallow Valley ships: music 44, ambience 48, sfx 72, mix 24
 * kbps; mix is the preview file of an adaptive song, which the player does not load). `web-mp3`: the gapless MP3 fallback.
 * `wav-master`: the exported WAVs themselves.
 */
export const PRESETS: Record<string, Delivery> = {
  'web-universal': { preset: 'web-universal', format: 'opus', kbps: { music: 44, ambience: 48, sfx: 72, mix: 24 } },
  'web-mp3': { preset: 'web-mp3', format: 'mp3', kbps: { ...FORMATS.mp3.defaultKbps, mix: 32 } },
  'wav-master': { preset: 'wav-master', format: 'wav' },
};

export function deliveryFor(target: string, kbps?: BuildConfig['kbps']): Delivery {
  const p = PRESETS[target];
  if (!p) throw new BeepsError('E_USAGE', `unknown target "${target}"`, { hint: `one of ${Object.keys(PRESETS).join(', ')}` });
  if (p.format === 'wav') return { preset: p.preset, format: 'wav' };
  const flags = encoderArgs(p.format, 0);
  const i = flags.indexOf('-b:a');
  flags.splice(i, 2);
  return { preset: p.preset, format: p.format, kbps: { ...p.kbps!, ...(kbps ?? {}) }, flags: flags.join(' ') };
}
