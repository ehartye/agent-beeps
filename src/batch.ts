// Transactional patch edits: validate every operation against in-memory copies first, then write.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BeepsError } from './errors.ts';
import { parsePatch, type Patch } from './schema/patch.ts';
import { listPatches, savePatch, type OpenProject } from './project.ts';
import { removePointer, setPointer } from './pointer.ts';

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), patch: z.unknown() }),
  z.object({ op: z.literal('set'), name: z.string(), pointer: z.string(), value: z.unknown() }),
  z.object({ op: z.literal('remove'), name: z.string(), pointer: z.string() }),
  z.object({ op: z.literal('delete'), name: z.string() }),
]);
export const OpsSchema = z.array(Op).min(1);
export type BatchOp = z.infer<typeof Op>;

export interface BatchResult { applied: number; dryRun: boolean; changed: string[]; deleted: string[] }

export function applyBatch(p: OpenProject, rawOps: unknown, { dryRun = false } = {}): BatchResult {
  const parsed = OpsSchema.safeParse(rawOps);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BeepsError('E_SCHEMA', `invalid operations: ${issue.message}`, { pointer: '/' + issue.path.join('/'), hint: 'ops are {op:"create",patch} | {op:"set",name,pointer,value} | {op:"remove",name,pointer} | {op:"delete",name}' });
  }
  const state = new Map<string, Patch>(listPatches(p).map(x => [x.name, x]));
  const changed = new Set<string>();
  const deleted = new Set<string>();
  parsed.data.forEach((op, operationIndex) => {
    const fail = (message: string, extra: { pointer?: string; hint?: string } = {}): never => {
      throw new BeepsError('E_SCHEMA', `operation ${operationIndex} (${op.op}): ${message}`, { ...extra, details: { operationIndex } });
    };
    const validate = (candidate: unknown): Patch => {
      const r = parsePatch(candidate);
      if (!r.ok) return fail(r.issues[0].message, { pointer: r.issues[0].pointer, hint: r.issues[0].hint });
      return r.patch;
    };
    if (op.op === 'create') {
      const patch = validate(op.patch);
      if (state.has(patch.name)) fail(`patch "${patch.name}" already exists`, { hint: 'use set operations to edit it' });
      state.set(patch.name, patch); changed.add(patch.name); deleted.delete(patch.name);
    } else {
      const current = state.get(op.name);
      if (!current) return fail(`no patch "${op.name}"`);
      if (op.op === 'delete') { state.delete(op.name); deleted.add(op.name); changed.delete(op.name); return; }
      const copy = structuredClone(current) as unknown;
      try {
        if (op.op === 'set') setPointer(copy, op.pointer, op.value);
        else removePointer(copy, op.pointer);
      } catch (e) { fail((e as Error).message, { pointer: op.pointer }); }
      const patch = validate(copy);
      if (patch.name !== op.name) fail('renaming via set is not supported', { pointer: '/name' });
      state.set(op.name, patch); changed.add(op.name);
    }
  });
  if (!dryRun) {
    for (const name of changed) savePatch(p, state.get(name)!, { force: true });
    for (const name of deleted) {
      const f = join(p.paths.patches, `${name}.json`);
      if (existsSync(f)) rmSync(f);
    }
  }
  return { applied: parsed.data.length, dryRun, changed: [...changed], deleted: [...deleted] };
}
