// EXPERIMENTAL (runtime-codegen spike). Minified + gzipped + brotli size of the runtime delivery options for N cues.
//   node scripts/runtime-size.mjs [--patches a.json,b.json,...] [--ns 1,3,5,10,18]
// Bundles with rolldown (a dependency of vitest, so present in a dev checkout); the numbers move a little with the game's bundler.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { build } from 'rolldown';
import { exportRuntime } from '../src/codegen/export.ts';
import { parsePatch } from '../src/schema/patch.ts';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const dirs = (arg('--patches', 'library/sounds/sci-fi/patches')).split(',');
const files = dirs.flatMap(d => (d.endsWith('.json') ? [d] : readdirSync(d).filter(f => f.endsWith('.json')).map(f => join(d, f))));
const ns = arg('--ns', '1,3,5,10,18').split(',').map(Number);
const patches = files.map(f => { const r = parsePatch(JSON.parse(readFileSync(f, 'utf8'))); if (!r.ok) throw new Error(`${f}: ${JSON.stringify(r.issues)}`); return r.patch; })
  .filter(p => p.layers.every(l => l.source.type !== 'voice'));

const base = mkdtempSync(join(tmpdir(), 'beeps-size-'));
const { root } = exportRuntime(base, patches.map(patch => ({ patch, trimDb: -9, seed: 1 })), { interpreter: true });

async function size(entrySource, name) {
  const entry = join(root, `${name}.entry.js`);
  writeFileSync(entry, entrySource);
  const out = await build({ input: entry, write: false, cwd: root, output: { format: 'esm', minify: true }, treeshake: true, logLevel: 'silent' });
  const code = out.output[0].code;
  const raw = Buffer.from(code);
  return { raw: raw.length, gz: gzipSync(raw, { level: 9 }).length, br: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
}

const rows = [];
rows.push({ what: 'interpreter alone (createVoice + buildPatch + every source type)', n: 0, ...(await size(`import { createVoice } from './engine/live.js'; globalThis.x = createVoice;`, 'interp0')) });
rows.push({ what: 'generated kernel alone (what any cue module pulls in, tree-shaken)', n: 0, ...(await size(`import { G, sumInto, db, voice, rp, buildLimiter } from './engine/gen.js'; globalThis.x = [G, sumInto, db, voice, rp, buildLimiter];`, 'gen0')) });
for (const n of ns) {
  const use = patches.slice(0, n);
  const interp = `import { createVoice } from './engine/live.js';\n${use.map((p, i) => `import p${i} from './patches/${p.name}.json' with { type: 'json' };`).join('\n')}\nglobalThis.x = [createVoice, ${use.map((_, i) => `p${i}`).join(', ')}];`;
  const gen = use.map((p, i) => `import * as c${i} from './cues/${p.name}.js';`).join('\n') + `\nglobalThis.x = [${use.map((_, i) => `c${i}`).join(', ')}];`;
  rows.push({ what: `interpreter + ${use.length} patches as data`, n: use.length, ...(await size(interp, `interp${n}`)) });
  rows.push({ what: `generated modules x ${use.length}`, n: use.length, ...(await size(gen, `gen${n}`)) });
}
console.log(JSON.stringify({ patches: patches.length, rows }, null, 1));

// ---- the baked alternative: what the same cues cost as Ogg Opus (the sfx default, 72 kbps) and as 48 kHz 16-bit WAV ----
if (process.argv.includes('--baked')) {
  const { openRenderHost } = await import('../src/render/host.ts');
  const { renderAndMeasure } = await import('../src/render/pipeline.ts');
  const { parseProject } = await import('../src/schema/project.ts');
  const { encodeOpus, findFfmpeg } = await import('../src/compress.ts');
  const { statSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'beeps-size-baked-'));
  const project = parseProject(JSON.parse(readFileSync(arg('--project', 'library/sounds/sci-fi/project.json'), 'utf8')));
  const host = await openRenderHost();
  const outs = await renderAndMeasure(host, patches.map(patch => ({ patch, seed: 1 })), { project, rendersDir: join(dir, 'renders') });
  await host.close();
  const ff = findFfmpeg();
  const per = outs.map((o, i) => {
    if (!o.ok) throw new Error(o.error);
    const ogg = join(dir, `${o.patch.name}.ogg`);
    encodeOpus(ff, o.wavPath, ogg, 72);
    const sec = o.features.durationSec;
    return { name: o.patch.name, sec, wav: statSync(o.wavPath).size, opus: statSync(ogg).size };
  });
  const sum = k => per.reduce((a, r) => a + r[k], 0);
  console.log(JSON.stringify({ baked: { cues: per.length, totalSec: Math.round(sum('sec') * 100) / 100, wavBytes: sum('wav'), opusBytes: sum('opus'), per } }, null, 1));
  rmSync(dir, { recursive: true, force: true });
}

rmSync(base, { recursive: true, force: true });
