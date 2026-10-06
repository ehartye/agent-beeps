// One catalog for the game player: every export sidecar under a directory, keyed by asset id, with
// file paths made relative to that directory.
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, type Stats } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { BeepsError } from './errors.ts';
import { ExportManifestSchema, type ExportManifest } from './export-manifest.ts';

/**
 * Every `*.wav.json`, `*.ogg.json` or `*.mp3.json` sidecar under `dir`, as paths relative to it (posix separators), sorted.
 * Never follows a symlink or (on Windows) a junction — `Dirent.isSymbolicLink()` reports the entry
 * itself, not its target, so a link back into an ancestor directory can't cause an infinite walk.
 * Skips dot-directories (`.git`, …) and `node_modules`.
 */
function listSidecars(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (e) {
      throw new BeepsError('E_NOT_FOUND', `${current}: ${(e as Error).message}`);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && /\.(wav|ogg|mp3)\.json$/.test(entry.name)) {
        out.push(relative(dir, full).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Resolves a sidecar's `file`/`variants[].file`/`layers[].file` against the sidecar's own directory.
 * Rejects anything that could point outside the bundle (an absolute path, a path that starts with
 * `..`, or one carrying a literal backslash — never a valid separator in these sidecars) and
 * requires the target to be an existing regular file (not a directory or symlink), so a stale or
 * hand-edited sidecar fails loudly at bundle time rather than 404ing in the browser.
 */
function assetPath(dir: string, rel: string, field: string, raw: string): string {
  const joined = posix.join(posix.dirname(rel), raw);
  if (posix.isAbsolute(joined) || joined === '..' || joined.startsWith('../') || joined.includes('\\')) {
    throw new BeepsError('E_SCHEMA', `${rel}: ${field} "${raw}" is not a safe path relative to the bundle directory (resolves to "${joined}")`, { pointer: `/${field}` });
  }
  let stat: Stats;
  try {
    stat = lstatSync(join(dir, joined));
  } catch {
    throw new BeepsError('E_NOT_FOUND', `${rel}: ${field} "${raw}" does not exist`, { pointer: `/${field}` });
  }
  // lstat, not stat: a symlink is refused even when its target is a real file, since it could point
  // anywhere on disk and a copied or vendored bundle would not carry it.
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BeepsError('E_SCHEMA', `${rel}: ${field} "${raw}" is not a regular file (resolves to "${joined}")`, { pointer: `/${field}` });
  }
  return joined;
}

export function bundleDir(dir: string): { index: string; assets: string[] } {
  const index = join(dir, 'index.json');
  if (existsSync(index)) {
    let previous: unknown;
    try { previous = JSON.parse(readFileSync(index, 'utf8')); } catch { previous = undefined; }
    const schema = previous && typeof previous === 'object' ? (previous as { schema?: unknown }).schema : undefined;
    // index.json is bundleDir's own output file: overwriting a previous bundle is fine, but a
    // foreign or hand-written index.json at that path must not be silently clobbered.
    if (schema !== 'beeps/audio-bundle@1') {
      throw new BeepsError('E_CONFLICT', `${index} already exists and is not a beeps/audio-bundle@1 catalog`, { hint: 'move or remove the existing index.json before bundling this directory' });
    }
  }
  const sidecars = listSidecars(dir);
  // A Map, not a plain object: an asset id of "constructor" (or any other Object.prototype name)
  // must never be mistaken for an inherited property.
  const assets = new Map<string, ExportManifest>();
  const from = new Map<string, string>();
  for (const rel of sidecars) {
    let text: string;
    try {
      text = readFileSync(join(dir, rel), 'utf8');
    } catch (e) {
      // The sidecar was listed a moment ago but can't be read now: an I/O problem (permissions, a
      // vanished file), not a content problem, so it gets its own code and the raw OS message.
      throw new BeepsError('E_NOT_FOUND', `${rel}: ${(e as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new BeepsError('E_SCHEMA', `${rel}: ${(e as Error).message}`);
    }
    const r = ExportManifestSchema.safeParse(raw);
    if (!r.success) throw new BeepsError('E_SCHEMA', `${rel}: not a beeps/audio-asset@1 sidecar (${r.error.issues[0].message})`, { pointer: '/' + r.error.issues[0].path.join('/') });
    const m = r.data;
    if (assets.has(m.id)) throw new BeepsError('E_CONFLICT', `asset id "${m.id}" is in both ${from.get(m.id)} and ${rel}`, { hint: 'rename one sound or song, or bundle the directories separately' });
    const file = assetPath(dir, rel, 'file', m.file);
    const variants = m.variants?.map((v, i) => ({ ...v, file: assetPath(dir, rel, `variants/${i}/file`, v.file) }));
    const layers = m.layers?.map((l, i) => ({ ...l, file: assetPath(dir, rel, `layers/${i}/file`, l.file) }));
    assets.set(m.id, { ...m, file, ...(variants ? { variants } : {}), ...(layers ? { layers } : {}) });
    from.set(m.id, rel);
  }
  writeFileSync(index, JSON.stringify({ schema: 'beeps/audio-bundle@1', assets: Object.fromEntries(assets) }, null, 2) + '\n');
  return { index, assets: [...assets.keys()] };
}
