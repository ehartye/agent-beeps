// RFC 6901 JSON pointers over plain JSON values.

const unescape = (s: string) => s.replaceAll('~1', '/').replaceAll('~0', '~');

export function parsePointer(ptr: string): string[] {
  if (ptr === '') return [];
  if (!ptr.startsWith('/')) throw new Error(`JSON pointer must start with "/": ${ptr}`);
  return ptr.slice(1).split('/').map(unescape);
}

export function hasPointer(obj: unknown, ptr: string): boolean {
  let cur: any = obj;
  for (const key of parsePointer(ptr)) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return false;
    cur = cur[key];
  }
  return true;
}

export function getPointer(obj: unknown, ptr: string): unknown {
  let cur: any = obj;
  for (const key of parsePointer(ptr)) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) throw new Error(`pointer ${ptr} does not resolve at "${key}"`);
    cur = cur[key];
  }
  return cur;
}

/** Sets a value, creating intermediate objects; array indexes must exist or be "-" (append). */
export function setPointer(obj: unknown, ptr: string, value: unknown): void {
  const keys = parsePointer(ptr);
  if (!keys.length) throw new Error('cannot set the root');
  // Validate the complete path before creating objects or following inherited properties.
  if (keys.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) throw new Error(`unsafe pointer: ${ptr}`);
  let cur: any = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] === undefined) cur[key] = {};
    cur = cur[key];
    if (cur === null || typeof cur !== 'object') throw new Error(`pointer ${ptr} crosses a non-object at "${key}"`);
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur) && last === '-') cur.push(value);
  else cur[last] = value;
}

export function removePointer(obj: unknown, ptr: string): void {
  const keys = parsePointer(ptr);
  const parent: any = keys.length > 1 ? getPointer(obj, '/' + keys.slice(0, -1).map(k => k.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')) : obj;
  const last = keys[keys.length - 1];
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else delete parent[last];
}
