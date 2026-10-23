// Strict schemas, introduced in two steps. A schema that strips a key it does not know turns a typo into a silent default
// ("scal" instead of "scale" leaves the default scale). The schemas are strict now; until the next minor release after this
// one a stray key is stripped and reported (N_UNKNOWN_KEY) so an existing file keeps loading. `parseTolerant` is the one place
// that fallback lives: when the release comes, callers switch to `schema.safeParse` and a stray key is an E_SCHEMA error.
import type { z } from 'zod';
import { escapePointer } from './pointer.ts';
import { notice, type Notice } from './notices.ts';

export interface UnknownKey { pointer: string; key: string }

export type Tolerant<T> = { ok: true; data: T; unknown: UnknownKey[] } | { ok: false; error: z.ZodError };

function stripAt(root: unknown, path: PropertyKey[], keys: string[]): void {
  let cur = root as Record<PropertyKey, unknown> | undefined;
  for (const step of path) {
    if (cur === null || typeof cur !== 'object') return;
    cur = cur[step as string] as Record<PropertyKey, unknown>;
  }
  if (cur !== null && typeof cur === 'object') for (const k of keys) delete cur[k];
}

/** Parse with a strict schema. When the only complaints are unknown keys, strip them and report where; any other complaint fails as it would. */
export function parseTolerant<S extends z.ZodType>(schema: S, input: unknown): Tolerant<z.output<S>> {
  const first = schema.safeParse(input);
  if (first.success) return { ok: true, data: first.data, unknown: [] };
  const stray = first.error.issues.filter((i): i is typeof i & { code: 'unrecognized_keys'; keys: string[] } => i.code === 'unrecognized_keys');
  if (!stray.length) return { ok: false, error: first.error };
  const copy = structuredClone(input);
  const unknown: UnknownKey[] = [];
  for (const issue of stray) {
    stripAt(copy, issue.path, issue.keys);
    for (const key of issue.keys) unknown.push({ pointer: '/' + [...issue.path, key].map(s => escapePointer(String(s))).join('/'), key });
  }
  const second = schema.safeParse(copy);
  return second.success ? { ok: true, data: second.data, unknown } : { ok: false, error: second.error };
}

/** One `N_UNKNOWN_KEY` per key that was stripped; `what` names the document ("project.json", "a batch operation"). */
export const unknownKeyNotices = (unknown: UnknownKey[], what: string): Notice[] => unknown.map(u => notice('N_UNKNOWN_KEY', {
  message: `"${u.key}" is not a key ${what} knows, so it was ignored`, pointer: u.pointer, requested: u.key,
}));
