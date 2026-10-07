import { createHash } from 'node:crypto';
import { ENGINE_VERSION } from '../runtime/engine/version.js';

export const SAMPLE_RATE = 48000;

/** JSON with object keys sorted at every level, so equal patches hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Cache key of one render: patch, render options, engine version and sample rate. */
export function renderKey(patch: unknown, opts: Record<string, unknown>): string {
  return sha256(canonicalJson({ patch, opts, engine: ENGINE_VERSION, sr: SAMPLE_RATE }));
}
