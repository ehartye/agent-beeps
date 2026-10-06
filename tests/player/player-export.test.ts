// tests/player/player-export.test.ts
import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportPlayer, PLAYER_FILES } from '../../src/commands/player.ts';
import { RUNTIME_DIR } from '../../src/render/host.ts';

it('vendors the player with every module it imports and a version header', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-vendor-'));
  try {
    const r = exportPlayer(dir);
    expect(r.root).toBe(join(dir, 'beeps-player'));
    expect(r.entry).toBe(join(r.root, 'player', 'player.js'));
    for (const f of PLAYER_FILES) {
      const file = join(r.root, f);
      const imports = [...readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)].map(m => resolve(dirname(file), m[1]));
      for (const i of imports) expect(existsSync(i), `${f} imports ${i}`).toBe(true);
    }
    const player = readFileSync(r.entry, 'utf8');
    expect(player.split('\n')[0]).toMatch(/^\/\/ Vendored by agent-beeps \d+\.\d+\.\d+ \(player 1, engine \d+\)/);
    expect(JSON.parse(readFileSync(join(r.root, 'VERSION.json'), 'utf8'))).toMatchObject({ player: '1' });
    const mod = await import(pathToFileURL(r.entry).href);
    expect(typeof mod.createPlayer).toBe('function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('every vendored file, not just player.js, carries the vendored header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-vendor-headers-'));
  try {
    const r = exportPlayer(dir);
    for (const f of PLAYER_FILES) {
      const first = readFileSync(join(r.root, f), 'utf8').split('\n')[0];
      expect(first, f).toMatch(/^\/\/ Vendored by agent-beeps .*Regenerate with "beeps player export"/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('re-exporting removes files left over from a previous export (a tool-owned directory)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-vendor-stale-'));
  try {
    exportPlayer(dir);
    const stale = join(dir, 'beeps-player', 'player', 'ghost.js');
    writeFileSync(stale, '// leftover from an older player version\n');
    expect(existsSync(stale)).toBe(true);
    exportPlayer(dir);
    expect(existsSync(stale)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Comments can hold a JSDoc type-only `@typedef {import('...')}`, which is erased at runtime and names files (like .ts sources) the player never loads: strip them before looking for real imports. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every specifier a module imports: static `from '...'`, side-effect `import '...'`, and dynamic `import('...')`; either quote style. */
function importSpecifiers(file: string): string[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  const specs = new Set<string>();
  for (const m of src.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)) specs.add(m[2]);
  for (const m of src.matchAll(/^\s*import\s*(['"])([^'"]+)\1/gm)) specs.add(m[2]);
  for (const m of src.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) specs.add(m[2]);
  return [...specs].filter(s => s.startsWith('.'));
}

/** Walks the import graph from an entry file (in the SOURCE tree), returning each visited file's path relative to `root`, forward-slashed. */
function walkImportGraph(entry: string, root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = resolve(queue.pop()!);
    const rel = relative(root, file).split(sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of importSpecifiers(file)) queue.push(resolve(dirname(file), spec));
  }
  return seen;
}

it('PLAYER_FILES is exactly the import graph reachable from runtime/player/player.js (drift guard)', () => {
  const entry = join(RUNTIME_DIR, 'player', 'player.js');
  const graph = walkImportGraph(entry, RUNTIME_DIR);
  // player.d.ts is the one shipped file that no module imports: it types player.js for TypeScript games.
  expect(new Set([...graph, 'player/player.d.ts'])).toEqual(new Set(PLAYER_FILES));
});
