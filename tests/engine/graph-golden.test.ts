// The engine's graph for 84 library and archetype patches, at three variants, snapping and not, as hashes (see
// tests/helpers/golden-matrix.ts). A change to how a patch becomes a graph shows up here as the exact cases it moved.
// If one moved on purpose: change engine/version.js or the render key as the change requires, say which cases moved in the
// commit, and regenerate with `node scripts/golden-graphs.mjs --write`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { graphHashes } from '../helpers/golden-matrix.ts';

it('builds the same graph as the committed golden hashes for every case in the matrix', async () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'graph-golden.json'), 'utf8')) as Record<string, string>;
  const now = await graphHashes();
  expect(Object.keys(now)).toEqual(Object.keys(golden));
  const moved = Object.keys(golden).filter(k => golden[k] !== now[k]);
  expect(moved).toEqual([]);
});
