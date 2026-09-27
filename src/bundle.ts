// One catalog for the game player: every export sidecar under a directory, keyed by asset id, with
// file paths made relative to that directory.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { BeepsError } from './errors.ts';
import { ExportManifestSchema, type ExportManifest } from './export-manifest.ts';

export function bundleDir(dir: string): { index: string; assets: string[] } {
  const sidecars = readdirSync(dir, { recursive: true }).map(f => String(f).split(sep).join('/')).filter(f => f.endsWith('.wav.json')).sort();
  const assets: Record<string, ExportManifest> = {};
  const from: Record<string, string> = {};
  for (const rel of sidecars) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, rel), 'utf8')); } catch (e) { throw new BeepsError('E_SCHEMA', `${rel}: ${(e as Error).message}`); }
    const r = ExportManifestSchema.safeParse(raw);
    if (!r.success) throw new BeepsError('E_SCHEMA', `${rel}: not a beeps/audio-asset@1 sidecar (${r.error.issues[0].message})`, { pointer: '/' + r.error.issues[0].path.join('/') });
    const m = r.data;
    if (m.id in assets) throw new BeepsError('E_CONFLICT', `asset id "${m.id}" is in both ${from[m.id]} and ${rel}`, { hint: 'rename one sound or song, or bundle the directories separately' });
    const at = (f: string) => posix.join(posix.dirname(rel), f);
    assets[m.id] = {
      ...m, file: at(m.file),
      ...(m.variants ? { variants: m.variants.map(v => ({ ...v, file: at(v.file) })) } : {}),
      ...(m.layers ? { layers: m.layers.map(l => ({ ...l, file: at(l.file) })) } : {}),
    };
    from[m.id] = rel;
  }
  const index = join(dir, 'index.json');
  writeFileSync(index, JSON.stringify({ schema: 'beeps/audio-bundle@1', assets }, null, 2) + '\n');
  return { index, assets: Object.keys(assets) };
}
