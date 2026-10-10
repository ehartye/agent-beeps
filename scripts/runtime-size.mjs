// Minified + gzipped + brotli size of what a game ships to play beeps patches live, from the generated runtime package.
//   node scripts/runtime-size.mjs [--patches dir-or.json,...] [--ns 1,3,5,10,18]
// Bundles with rolldown (a dependency of vitest, so present in a dev checkout); the numbers move a little with the game's bundler.
// Rows: the engine alone (what `build` reaches, and every export), then N patches as JSON data beside it.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { build } from 'rolldown';
import { generate } from './build-runtime-package.mjs';
import { parsePatch } from '../src/schema/patch.ts';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const dirs = arg('--patches', 'library/sounds/sci-fi/patches').split(',');
const files = dirs.flatMap(d => (d.endsWith('.json') ? [d] : readdirSync(d).filter(f => f.endsWith('.json')).map(f => join(d, f))));
const ns = arg('--ns', '1,3,5,10,18').split(',').map(Number);
const patches = files.map(f => { const r = parsePatch(JSON.parse(readFileSync(f, 'utf8'))); if (!r.ok) throw new Error(`${f}: ${JSON.stringify(r.issues)}`); return r.patch; });

const dir = mkdtempSync(join(tmpdir(), 'beeps-size-'));
try {
  for (const [path, content] of generate()) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), content); }
  async function size(source, name) {
    const entry = join(dir, `${name}.entry.js`);
    writeFileSync(entry, source);
    const out = await build({ input: entry, write: false, cwd: dir, output: { format: 'esm', minify: true }, treeshake: true, logLevel: 'silent' });
    const raw = Buffer.from(out.output[0].code);
    return { raw: raw.length, gz: gzipSync(raw, { level: 9 }).length, br: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
  }
  const rows = [{ what: 'engine: build + createReverbBus + parseCue', ...(await size("import { build, createReverbBus, parseCue } from './runtime/engine/index.js'; console.log(build, createReverbBus, parseCue);", 'engine')) }];
  rows.push({ what: 'engine: every export', ...(await size("import * as r from './runtime/engine/index.js'; console.log(r);", 'all')) });
  for (const n of ns) {
    const data = JSON.stringify(patches.slice(0, n));
    const body = `import { build } from './runtime/engine/index.js'; const patches = ${data}; console.log(build, patches);`;
    rows.push({ what: `engine + ${n} patches as data`, ...(await size(body, `n${n}`)) });
  }
  console.log(JSON.stringify({ patches: patches.length, rows }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
