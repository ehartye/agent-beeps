// @ts-nocheck -- dependency-free launcher policy; tested with isolated managed releases.
import { readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describeSource, managedHome, resolveRuntime } from './managed-runtime.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const fields = ['chromium', 'engine', 'exportPipeline', 'pipeline', 'playwright', 'sampleRate', 'songPipeline'];
function identity(value) {
  if (!value || typeof value !== 'object' || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields)) return null;
  for (const key of fields) {
    const v = value[key];
    if (['chromium', 'playwright'].includes(key)) { if (typeof v !== 'string' || !v || /unknown/i.test(v)) return null; }
    else if (key === 'engine' && typeof v === 'string') { if (!v || /unknown/i.test(v)) return null; }
    else if (!Number.isFinite(v) || v < 0) return null;
  }
  return JSON.stringify(Object.fromEntries(fields.map(key => [key, value[key]])));
}
function read(path, limit) {
  if (!lstatSync(path).isFile() || lstatSync(path).size > limit) fail('E_LOCK', `Expected a bounded regular file: ${path}`);
  return readFileSync(path, 'utf8');
}
function installed(root, home) {
  const releases = realpathSync(join(home, 'releases'));
  if (releases !== join(realpathSync(home), 'releases')) throw new Error('managed releases directory escapes its home');
  if (lstatSync(root).isSymbolicLink() || realpathSync(dirname(root)) !== releases || realpathSync(root) !== join(releases, basename(root))) throw new Error('managed release escapes its home');
  const description = describeSource(root);
  const receipt = JSON.parse(read(join(root, 'managed-install.json'), 65536));
  if (basename(root) !== description.key || receipt.key !== description.key || receipt.fingerprint !== description.fingerprint) throw new Error('managed receipt/content/platform identity mismatch');
  return { ...description, root, cli: join(root, 'scripts/beeps.mjs') };
}

/** Only selection is owned here. The chosen CLI retains all recipe and output hashing.
 * @param {string} source
 * @param {string} config
 * @param {{home?: string, runtimeSource?: string}} options
 */
export function selectLockedRuntime(source, config, { home = managedHome(), runtimeSource } = {}) {
  config = resolve(config);
  const configText = read(config, 1024 * 1024);
  let cfg, lock, lockText;
  try {
    cfg = JSON.parse(configText);
    if (!cfg || typeof cfg !== 'object' || (cfg.lock !== undefined && typeof cfg.lock !== 'string')) throw new Error('config.lock must be a path');
    lock = resolve(dirname(config), cfg.lock ?? 'audio.lock.json');
    lockText = read(lock, 16 * 1024 * 1024);
  } catch (error) { fail('E_LOCK', `Cannot read locked check inputs: ${error.message}`); }
  let record;
  try { record = JSON.parse(lockText); } catch { fail('E_LOCK', `Malformed lock: ${lock}`); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('E_LOCK', `Malformed lock object: ${lock}`);
  const wanted = identity(record.toolchain);
  if (record.schema !== 'beeps/build-lock@1' || record.keyScheme !== 'beeps-input@1' || !wanted || !record.assets || typeof record.assets !== 'object' || Array.isArray(record.assets)) fail('E_LOCK', `Unsupported or incomplete lock/toolchain at ${lock}; no runtime selected`);
  home = resolve(home);
  let candidates;
  if (runtimeSource) {
    if (!isAbsolute(runtimeSource)) fail('E_USAGE', '--runtime-source must be an absolute trusted pinned plugin source');
    try { candidates = [resolveRuntime(runtimeSource, { home }).root]; }
    catch (error) { fail('E_RUNTIME_MISSING', `${error.message} The requested pin is ${runtimeSource}; no fallback or asset changes were made.`); }
  } else {
    try { candidates = readdirSync(join(home, 'releases'), { withFileTypes: true }).filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map(e => join(home, 'releases', e.name)); }
    catch (error) { if (error.code === 'ENOENT') candidates = []; else throw error; }
  }
  if (candidates.length > 64) fail('E_TOOLCHAIN', 'Too many installed candidates; select a trusted pin with --runtime-source');
  const matches = [], rejected = [], deadline = Date.now() + 15000;
  for (const root of candidates.sort()) {
    if (Date.now() >= deadline) fail('E_TOOLCHAIN', 'Runtime discovery deadline exceeded; select a trusted pin with --runtime-source');
    try {
      const runtime = installed(root, home);
      const probe = `import {currentToolchain} from ${JSON.stringify(pathToFileURL(join(root, 'src/build/lock.ts')).href)}; console.log(JSON.stringify(currentToolchain()));`;
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail('E_TOOLCHAIN', 'Runtime discovery budget exhausted during fingerprinting; select a trusted pin with --runtime-source');
      const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: Math.min(5000, remaining), maxBuffer: 65536, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
      if (identity(actual) === wanted) matches.push(runtime);
      else rejected.push(`${runtime.version}: incompatible toolchain`);
    } catch (error) {
      if (error.code === 'E_TOOLCHAIN') throw error;
      rejected.push(`${basename(root)}: invalid or unavailable runtime (${String(error.message).slice(0, 180)})`);
    }
  }
  let selected;
  if (!runtimeSource && matches.length > 1) {
    const loaded = describeSource(source);
    selected = matches.find(r => r.fingerprint === loaded.fingerprint && r.version === loaded.version);
  } else selected = matches[0];
  if (!selected) {
    const code = matches.length || runtimeSource ? 'E_TOOLCHAIN' : 'E_RUNTIME_MISSING';
    fail(code, `${matches.length ? 'Ambiguous compatible runtimes' : 'No compatible installed runtime'} for ${lock}. Locked toolchain: ${wanted}. ${rejected.join('; ')}. The lock does not declare a package/source pin. Restore the trusted project/CI pin with node "<pinned-plugin-root>/scripts/setup.js" using AGENT_BEEPS_HOME=${JSON.stringify(home)}, then retry with --runtime-source "<absolute-pinned-plugin-root>". No render, adoption or rebaseline was performed.`);
  }
  // Refuse edits made during discovery; do not dispatch against an unqualified snapshot.
  if (read(config, 1024 * 1024) !== configText || read(lock, 16 * 1024 * 1024) !== lockText || installed(selected.root, home).fingerprint !== selected.fingerprint) fail('E_CONFLICT', 'Lock, config or selected runtime changed during qualification; retry the read-only check');
  if (runtimeSource && resolveRuntime(runtimeSource, { home }).fingerprint !== selected.fingerprint) fail('E_CONFLICT', 'Pinned source changed during qualification');
  return { ...selected, config, lock, toolchain: JSON.parse(wanted) };
}
