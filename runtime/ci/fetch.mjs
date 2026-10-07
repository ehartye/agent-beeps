#!/usr/bin/env node
// Materialises an app's audio from the content-addressed store, with no dependencies: Node 20+ built-ins only. No agent-beeps
// checkout, no Chromium, no ffmpeg. Reads the committed audio.lock.json, downloads each missing asset (a tar named by its input hash),
// checks every file's sha256 and size against the LOCK (never against the store's own manifest), writes it atomically, and
// regenerates index.json exactly as `beeps bundle` does.
//
//   node fetch.mjs [--lock <audio.lock.json>] [--out <dir>] [--store <spec>] [--only a,b] [--check] [--jobs 6]
//
// Store specs: dir:<path> (relative to the working directory) | release:<owner/repo>[@tag]. GITHUB_TOKEN is used when set (private store
// repos); a public store needs none. Exit 0: every asset present and verified. Exit 1: something is missing or does not verify (named).
// Vendored by `beeps ci export`; do not edit.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = /*beeps:defaults*/ {};

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const has = (n) => args.includes(`--${n}`);
const fail = (m) => { console.error(`fetch.mjs: ${m}`); process.exit(1); };

const lockPath = flag('lock') ? resolve(flag('lock')) : DEFAULTS.lock ? resolve(here, DEFAULTS.lock) : fail('--lock <audio.lock.json> is required');
const outDir = flag('out') ? resolve(flag('out')) : DEFAULTS.out ? resolve(here, DEFAULTS.out) : fail('--out <dir> is required');
const storeSpec = flag('store') ?? process.env.BEEPS_AUDIO_STORE ?? DEFAULTS.store;
const only = flag('only')?.split(',').filter(Boolean);
const jobs = Number(flag('jobs') ?? 6);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ---- tar (flat regular files) ----
function readTar(buf) {
  const out = new Map();
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.toString('ascii', a, b).replace(/\0[\s\S]*$/, '').trim();
    const name = h.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 136), 8);
    const type = h.toString('ascii', 156, 157);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (!Number.isFinite(size) || sum !== parseInt(field(148, 156), 8)) throw new Error('corrupt tar header');
    if (type !== '0' && type !== '\0') throw new Error(`tar entry ${name} is not a regular file`);
    if (!name || /[\\/:\0]/.test(name) || name === '.' || name === '..') throw new Error(`tar entry "${name}" is not a flat file name`);
    off += 512;
    if (off + size > buf.length) throw new Error(`tar entry ${name} is truncated`);
    out.set(name, buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

// ---- stores ----
function openStore(spec) {
  if (!spec) fail('no store: pass --store dir:<path> | release:<owner/repo>[@tag] (or set BEEPS_AUDIO_STORE)');
  if (spec.startsWith('dir:')) {
    const dir = resolve(spec.slice(4));
    return { async get(name) { const f = join(dir, name); return existsSync(f) ? readFileSync(f) : undefined; } };
  }
  const m = spec.match(/^release:([\w.-]+\/[\w.-]+)(?:@([\w./-]+))?$/);
  if (!m) fail(`unknown store "${spec}"`);
  const [, repo, base = 'audio-store'] = m;
  const headers = (extra = {}) => ({ accept: 'application/vnd.github+json', 'user-agent': 'agent-beeps-fetch', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
  let loading; // one shared load: the first call starts it and every concurrent get() awaits the same promise
  const load = () => (loading ??= loadIndex());
  const loadIndex = async () => {
    const index = new Map(); // name -> asset, over the release chain tag, tag-1, tag-2, ...
    for (let n = 0; ; n++) {
      const tag = n === 0 ? base : `${base}-${n}`;
      const r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: headers() });
      if (r.status === 404) break;
      if (!r.ok) throw new Error(`GitHub ${r.status} reading release ${tag} of ${repo}`);
      const { id } = await r.json();
      for (let page = 1; ; page++) {
        const a = await fetch(`https://api.github.com/repos/${repo}/releases/${id}/assets?per_page=100&page=${page}`, { headers: headers() });
        if (!a.ok) throw new Error(`GitHub ${a.status} listing assets of ${tag}`);
        const list = await a.json();
        for (const x of list) if (!index.has(x.name)) index.set(x.name, x);
        if (list.length < 100) break;
      }
    }
    return index;
  };
  return {
    async get(name) {
      const a = (await load()).get(name);
      if (!a) return undefined;
      // A token goes through the API (private repos); without one the public download URL has no API rate limit.
      const r = token
        ? await fetch(`https://api.github.com/repos/${repo}/releases/assets/${a.id}`, { headers: headers({ accept: 'application/octet-stream' }), redirect: 'follow' })
        : await fetch(a.browser_download_url, { headers: { 'user-agent': 'agent-beeps-fetch' }, redirect: 'follow' });
      if (!r.ok) throw new Error(`GitHub ${r.status} downloading ${name}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}

// ---- the lock ----
let lock;
try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch (e) { fail(`cannot read ${lockPath}: ${e.message}`); }
if (lock.schema !== 'beeps/build-lock@1' || typeof lock.assets !== 'object') fail(`${lockPath} is not a beeps/build-lock@1 lock`);
const ids = Object.keys(lock.assets).sort().filter((id) => !only || only.includes(id));
if (only) for (const id of only) if (!lock.assets[id]) fail(`--only: no asset "${id}" in the lock`);

const okOnDisk = (o) => {
  const f = join(outDir, o.file);
  return existsSync(f) && statSync(f).size === o.bytes && sha256(readFileSync(f)) === o.sha256;
};

function writeAtomic(dest, data) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, dest);
}

const missing = [], bad = [];
let present = 0, fetched = 0;
const need = ids.filter((id) => {
  const ok = lock.assets[id].outputs.every(okOnDisk);
  if (ok) present++;
  return !ok;
});

if (has('check')) {
  for (const id of need) bad.push(`${id}: outputs missing or modified`);
} else if (need.length) {
  const store = openStore(storeSpec);
  const queue = [...need];
  const work = async () => {
    for (let id; (id = queue.shift()) !== undefined;) {
      const a = lock.assets[id];
      const name = `${a.inputHash.replace(/^sha256:/, '')}.tar`;
      try {
        const tar = await store.get(name);
        if (!tar) { missing.push(`${id} (${name.slice(0, 12)}...)`); continue; }
        const files = readTar(tar);
        // Every file is checked against the lock before anything is written: a poisoned or stale store entry writes nothing.
        let problem;
        for (const o of a.outputs) {
          const d = files.get(o.file);
          if (!d) { problem = `${o.file} is not in the store entry`; break; }
          if (d.length !== o.bytes || sha256(d) !== o.sha256) { problem = `${o.file} does not match the lock (sha256 ${sha256(d).slice(0, 12)}, expected ${o.sha256.slice(0, 12)})`; break; }
        }
        if (problem) { bad.push(`${id}: ${problem}`); continue; }
        for (const o of a.outputs) if (!okOnDisk(o)) writeAtomic(join(outDir, o.file), files.get(o.file));
        fetched++;
      } catch (e) { bad.push(`${id}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, queue.length)) }, work));
}

// ---- index.json, as beeps bundle writes it ----
if (!missing.length && !bad.length && !only) {
  const sidecars = ids.flatMap((id) => lock.assets[id].outputs.map((o) => o.file)).filter((f) => /\.(wav|ogg|mp3)\.json$/.test(f)).sort();
  const assets = new Map();
  for (const rel of sidecars) {
    const m = JSON.parse(readFileSync(join(outDir, rel), 'utf8'));
    const at = (raw) => posix.join(posix.dirname(rel), raw);
    const variants = m.variants?.map((v) => ({ ...v, file: at(v.file) }));
    const layers = m.layers?.map((l) => ({ ...l, file: at(l.file) }));
    assets.set(m.id, { ...m, file: at(m.file), ...(variants ? { variants } : {}), ...(layers ? { layers } : {}) });
  }
  const text = JSON.stringify({ schema: 'beeps/audio-bundle@1', assets: Object.fromEntries(assets) }, null, 2) + '\n';
  const index = join(outDir, 'index.json');
  if (!existsSync(index) || readFileSync(index, 'utf8') !== text) writeAtomic(index, text);
}

const summary = { ok: !missing.length && !bad.length, assets: ids.length, present, fetched, missing, problems: bad };
console.log(JSON.stringify(summary));
if (missing.length) console.error(`fetch.mjs: ${missing.length} asset(s) are not in the store (the author must run "beeps build --push" or "beeps store push"):\n  ${missing.slice(0, 20).join('\n  ')}`);
if (bad.length) console.error(`fetch.mjs: ${bad.length} problem(s):\n  ${bad.slice(0, 20).join('\n  ')}`);
process.exit(summary.ok ? 0 : 1);
