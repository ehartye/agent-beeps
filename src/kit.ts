// The project kit: which shipped sounds belong together, their family and voice priority.
// Pure file and list helpers only; rendering and checking members is the CLI's job (see lint.ts lintKit).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BeepsError } from './errors.ts';
import { pointerOf } from './schema/patch.ts';

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export const KitEntrySchema = z.strictObject({
  name: z.string().regex(NAME, 'lowercase letters, digits and dashes'),
  family: z.string().regex(NAME, 'lowercase letters, digits and dashes'),
  /** Voice priority: smaller is more important (FMOD convention). The priority-levels rule caps distinct levels. */
  priority: z.number().int().min(1),
  /** Loudness trim (dB) measured when the sound was rendered, so players and auditions play it at level. */
  trimDb: z.number().optional(),
  /** Render seed the owner auditioned: seeded sources (noise, grains) sound different under another seed. */
  seed: z.number().int().optional(),
});
export const KitSchema = z.strictObject({
  schema: z.literal('beeps/kit@1'),
  sounds: z.array(KitEntrySchema),
});

export type KitEntry = z.output<typeof KitEntrySchema>;
export type Kit = z.output<typeof KitSchema>;

export const kitPath = (dir: string) => join(dir, '.agent-beeps', 'kit.json');
export const emptyKit = (): Kit => ({ schema: 'beeps/kit@1', sounds: [] });

export function parseKit(input: unknown): Kit {
  const r = KitSchema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new BeepsError('E_SCHEMA', `kit.json is invalid: ${issue.message}`, { pointer: pointerOf(issue.path) });
}

/** Reads `<dir>/.agent-beeps/kit.json`; a project without one has an empty kit. */
export function readKit(dir: string): Kit {
  const path = kitPath(dir);
  if (!existsSync(path)) return emptyKit();
  let json: unknown;
  try { json = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    throw new BeepsError('E_SCHEMA', `kit.json is not valid JSON: ${(e as Error).message}`);
  }
  return parseKit(json);
}

export function writeKit(dir: string, kit: Kit): string {
  const valid = parseKit(kit);
  const path = kitPath(dir);
  mkdirSync(join(dir, '.agent-beeps'), { recursive: true });
  writeFileSync(path, JSON.stringify(valid, null, 2) + '\n');
  return path;
}

/** Adds an entry, replacing any entry with the same name in place. Returns a new kit. */
export function addToKit(kit: Kit, entry: KitEntry): Kit {
  const r = KitEntrySchema.safeParse(entry);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new BeepsError('E_SCHEMA', `kit entry is invalid: ${issue.message}`, { pointer: pointerOf(issue.path) });
  }
  const valid = r.data;
  const i = kit.sounds.findIndex(s => s.name === valid.name);
  const sounds = i < 0 ? [...kit.sounds, valid] : kit.sounds.map((s, k) => (k === i ? valid : s));
  return { ...kit, sounds };
}

/** Removes the named entry. Throws E_NOT_FOUND if the kit does not contain it. */
export function removeFromKit(kit: Kit, name: string): Kit {
  if (!kit.sounds.some(s => s.name === name)) throw new BeepsError('E_NOT_FOUND', `kit has no sound named "${name}"`);
  return { ...kit, sounds: kit.sounds.filter(s => s.name !== name) };
}
