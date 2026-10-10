#!/usr/bin/env node
// Compute (or compare) the engine's golden graph hashes. Usage:
//   node scripts/golden-graphs.mjs --write                  rewrite tests/engine/graph-golden.json from this checkout's engine
//   node scripts/golden-graphs.mjs --engine <dir>           print the hashes of another engine directory (e.g. an older checkout)
//   node scripts/golden-graphs.mjs --diff <dirA> <dirB>     list the cases whose graph differs between two engine directories
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { graphHashes } from '../tests/helpers/golden-matrix.ts';

const [mode, a, b] = process.argv.slice(2);
if (mode === '--write') {
  const hashes = await graphHashes();
  writeFileSync(join(import.meta.dirname, '..', 'tests', 'engine', 'graph-golden.json'), JSON.stringify(hashes, null, 1) + '\n');
  console.log(`wrote ${Object.keys(hashes).length} hashes`);
} else if (mode === '--engine' && a) {
  console.log(JSON.stringify(await graphHashes(resolve(a)), null, 1));
} else if (mode === '--diff' && a && b) {
  const x = await graphHashes(resolve(a)), y = await graphHashes(resolve(b));
  const changed = Object.keys(x).filter(k => x[k] !== y[k]);
  console.log(`${changed.length} of ${Object.keys(x).length} cases differ`);
  for (const k of changed) console.log(k);
} else { console.error('usage: golden-graphs.mjs --write | --engine <dir> | --diff <dirA> <dirB>'); process.exitCode = 1; }
