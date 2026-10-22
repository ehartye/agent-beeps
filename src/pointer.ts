// RFC 6901 JSON pointers over plain JSON values: the one implementation the CLI, archetypes, families and patch checks share.
import { BeepsError } from './errors.ts';

type Container = Record<string, unknown> | unknown[];

/** Escape one key for use inside a pointer (`~` then `/`, RFC 6901 section 3). */
export const escapePointer = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
/** The key a pointer token names (`~1` then `~0`). */
export const unescapePointer = (token: string): string => token.replaceAll('~1', '/').replaceAll('~0', '~');

const isContainer = (v: unknown): v is Container => v !== null && typeof v === 'object';
/** Own keys only; array keys must be canonical indexes inside the array. Inherited members never resolve. */
const hasKey = (obj: Container, key: string): boolean => (Array.isArray(obj) ? /^(0|[1-9]\d*)$/.test(key) && Number(key) < obj.length : Object.hasOwn(obj, key));
const child = (obj: Container, key: string): unknown => (Array.isArray(obj) ? obj[Number(key)] : obj[key]);

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function parsePointer(ptr: string): string[] {
  if (ptr === '') return [];
  if (!ptr.startsWith('/')) throw new BeepsError('E_USAGE', `JSON pointer must start with "/": ${ptr}`);
  return ptr.slice(1).split('/').map(unescapePointer);
}

/** Follow `keys` from `obj`: the value reached, or the first key that does not resolve. */
function walk(obj: unknown, keys: string[]): { ok: true; value: unknown } | { ok: false; key: string } {
  let cur = obj;
  for (const key of keys) {
    if (!isContainer(cur) || !hasKey(cur, key)) return { ok: false, key };
    cur = child(cur, key);
  }
  return { ok: true, value: cur };
}

export function hasPointer(obj: unknown, ptr: string): boolean {
  return walk(obj, parsePointer(ptr)).ok;
}

/** The value at `ptr`; E_USAGE naming the step that is missing. */
export function getPointer(obj: unknown, ptr: string): unknown {
  const r = walk(obj, parsePointer(ptr));
  if (!r.ok) throw new BeepsError('E_USAGE', `pointer ${ptr} does not resolve at "${r.key}"`);
  return r.value;
}

/** The value at `ptr`, or undefined when any step is missing or the pointer is malformed. Never throws. */
export function tryGetPointer(obj: unknown, ptr: string): unknown {
  try {
    const r = walk(obj, parsePointer(ptr));
    return r.ok ? r.value : undefined;
  } catch { return undefined; }
}

/** Sets a value, creating intermediate objects; array indexes must exist or be "-" (append). */
export function setPointer(obj: unknown, ptr: string, value: unknown): void {
  const keys = parsePointer(ptr);
  if (!keys.length) throw new BeepsError('E_USAGE', 'cannot set the root');
  // Validate the complete path before creating objects or following inherited properties.
  if (keys.some(key => UNSAFE_KEYS.has(key))) throw new BeepsError('E_USAGE', `unsafe pointer: ${ptr}`);
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (!isContainer(cur)) throw new BeepsError('E_USAGE', `pointer ${ptr} crosses a non-object at "${key}"`);
    const rec = cur as Record<string, unknown>;
    if (rec[key] === undefined) rec[key] = {};
    cur = rec[key];
    if (!isContainer(cur)) throw new BeepsError('E_USAGE', `pointer ${ptr} crosses a non-object at "${key}"`);
  }
  if (!isContainer(cur)) throw new BeepsError('E_USAGE', `no object at the parent of ${ptr}`);
  const last = keys[keys.length - 1];
  if (Array.isArray(cur) && last === '-') cur.push(value);
  else (cur as Record<string, unknown>)[last] = value;
}

/** Replaces the value at `ptr` in place. Nothing is created: the parent must exist, and an array index must already be in range. */
export function replacePointer(obj: unknown, ptr: string, value: unknown): void {
  const keys = parsePointer(ptr);
  if (!keys.length) throw new BeepsError('E_USAGE', 'cannot set the root of a document', { pointer: ptr });
  if (keys.some(key => UNSAFE_KEYS.has(key))) throw new BeepsError('E_USAGE', `unsafe pointer: ${ptr}`, { pointer: ptr });
  let parent = obj;
  for (const key of keys.slice(0, -1)) {
    if (!isContainer(parent) || !hasKey(parent, key)) throw new BeepsError('E_USAGE', `no value at ${key} on the way to ${ptr}`, { pointer: ptr });
    parent = child(parent, key);
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(parent)) {
    if (!hasKey(parent, last)) throw new BeepsError('E_USAGE', `no array index ${last} at ${ptr}`, { pointer: ptr });
    parent[Number(last)] = value;
  } else if (isContainer(parent)) (parent as Record<string, unknown>)[last] = value;
  else throw new BeepsError('E_USAGE', `no object at the parent of ${ptr}`, { pointer: ptr });
}

export function removePointer(obj: unknown, ptr: string): void {
  const keys = parsePointer(ptr);
  const parent = keys.length > 1 ? getPointer(obj, '/' + keys.slice(0, -1).map(escapePointer).join('/')) : obj;
  if (!isContainer(parent)) throw new BeepsError('E_USAGE', `no object at the parent of ${ptr}`);
  const last = keys[keys.length - 1];
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else delete parent[last];
}
