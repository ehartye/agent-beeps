// The engine's graph for a fixed matrix of cases, as hashes: every library patch and 2 samples of every archetype, built on the
// recording FakeContext at variants 0 to 2 with the project scale snapping and not. Browser independent (it hashes the graph the
// engine asks the browser for, not the samples the browser makes of it), so it can be committed and compared on any machine.
// `tests/engine/graph-golden.test.ts` holds the committed hashes; regenerate them with `node scripts/golden-graphs.mjs --write`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadArchetypes, sampleArchetype } from '../../src/archetypes.ts';
import { parsePatch, type Patch } from '../../src/schema/patch.ts';
import { dumpGraph } from './graph-dump.ts';
import { FakeContext, asCtx } from './fake-context.ts';

const ROOT = join(import.meta.dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : []));
}

/** Every library patch (a beeps/patch@1 file under library/sounds), parsed. */
export function libraryPatches(): { id: string; patch: Patch }[] {
  const out: { id: string; patch: Patch }[] = [];
  for (const file of walk(join(ROOT, 'library', 'sounds')).sort()) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw?.schema !== 'beeps/patch@1') continue;
    const r = parsePatch(raw);
    if (r.ok) out.push({ id: relative(join(ROOT, 'library', 'sounds'), file).split(sep).join('/'), patch: r.patch });
  }
  return out;
}

export function matrixPatches(): { id: string; patch: Patch }[] {
  const out = libraryPatches();
  for (const a of loadArchetypes()) sampleArchetype(a, 11, 2).forEach((patch, i) => out.push({ id: `archetype/${a.name}#${i}`, patch }));
  return out;
}

/** @param engineDir a directory holding patch.js (default: this checkout's runtime/engine) */
export async function graphHashes(engineDir = join(ROOT, 'runtime', 'engine')): Promise<Record<string, string>> {
  const { buildPatch } = await import(pathToFileURL(join(engineDir, 'patch.js')).href);
  const out: Record<string, string> = {};
  for (const { id, patch } of matrixPatches()) {
    for (const snap of [true, false]) {
      for (const variant of [0, 1, 2]) {
        const f = new FakeContext();
        buildPatch(asCtx(f), patch, { seed: 7, variant, scale: { root: 'C', mode: 'majorPentatonic', snap }, trimDb: -3 });
        out[`${id} snap=${snap} v${variant}`] = createHash('sha256').update(JSON.stringify(dumpGraph(f))).digest('hex').slice(0, 16);
      }
    }
  }
  return out;
}
