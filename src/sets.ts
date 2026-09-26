// Candidate sets: the output of generate/mutate, the input of an audition.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BeepsError } from './errors.ts';
import type { OpenProject } from './project.ts';
import type { Rendered } from './render/pipeline.ts';
import type { Patch } from './schema/patch.ts';

const CandidateSchema = z.object({
  index: z.number().int().positive(),
  name: z.string(),
  key: z.string(),
  seed: z.number().int().default(1),
  trimDb: z.number(),
  features: z.record(z.string(), z.unknown()),
  wav: z.string(),
  look: z.string(),
  weak: z.boolean().optional(),
});
export type SetCandidate = z.infer<typeof CandidateSchema>;

export const SetSchema = z.object({
  schema: z.literal('beeps/set@1'),
  id: z.string(),
  archetype: z.string().nullable(),
  family: z.string(),
  prompt: z.string().nullable(),
  parent: z.string().nullable().default(null),
  createdAt: z.string(),
  candidates: z.array(CandidateSchema),
  sheet: z.string().nullable().default(null),
});
export type CandidateSet = z.infer<typeof SetSchema>;

const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
export const newId = (prefix: string) => `${prefix.replace(/[^a-z0-9-]/g, '-')}-${stamp()}-${randomBytes(2).toString('hex')}`;

export const setDir = (p: OpenProject, id: string) => join(p.paths.sets, id);

export function writeSet(p: OpenProject, set: Omit<CandidateSet, 'schema'>, patches: Patch[]): CandidateSet {
  const full = SetSchema.parse({ schema: 'beeps/set@1', ...set });
  const dir = setDir(p, full.id);
  mkdirSync(join(dir, 'candidates'), { recursive: true });
  for (const patch of patches) writeFileSync(join(dir, 'candidates', `${patch.name}.json`), JSON.stringify(patch, null, 2) + '\n');
  writeFileSync(join(dir, 'set.json'), JSON.stringify(full, null, 2) + '\n');
  return full;
}

export function readSet(p: OpenProject, id: string): CandidateSet {
  if (!/^[a-z0-9-]+$/.test(id)) throw new BeepsError('E_NOT_FOUND', `invalid set id "${id}"`);
  const file = join(setDir(p, id), 'set.json');
  if (!existsSync(file)) throw new BeepsError('E_NOT_FOUND', `no set "${id}"`, { hint: 'generate one with "beeps generate <archetype>"' });
  return SetSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function setCandidatePatch(p: OpenProject, setId: string, name: string): Patch {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(setId) || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new BeepsError('E_NOT_FOUND', 'invalid set or candidate name');
  return JSON.parse(readFileSync(join(setDir(p, setId), 'candidates', `${name}.json`), 'utf8'));
}

export const candidateFromRendered = (r: Rendered, index: number, weak?: boolean): SetCandidate => ({
  index, name: r.patch.name, key: r.key, seed: r.seed, trimDb: r.trimDb,
  features: r.features as unknown as Record<string, unknown>, wav: r.wavPath, look: r.lookPath,
  ...(weak ? { weak } : {}),
});
