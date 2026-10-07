import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

describe('install scripts', () => {
  // The managed runtime installs with --omit=dev, so only runtime dependencies must be approved (fsevents is a macOS-only dev watcher).
  it('pins every locked runtime dependency that runs an install script in allowScripts (npm refuses unapproved ones)', () => {
    const withScripts = Object.entries(lock.packages as Record<string, { version?: string; hasInstallScript?: boolean; dev?: boolean }>)
      .filter(([path, p]) => path.startsWith('node_modules/') && p.hasInstallScript && !p.dev)
      .map(([path, p]) => `${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${p.version}`);
    expect(withScripts).toContain('ffmpeg-static@5.3.0');
    for (const id of withScripts) expect(pkg.allowScripts?.[id], `${id} is not approved in package.json allowScripts`).toBe(true);
  });

  it('approves nothing that is not in the lock', () => {
    const locked = new Set(Object.entries(lock.packages as Record<string, { version?: string }>)
      .filter(([path]) => path.startsWith('node_modules/'))
      .map(([path, p]) => `${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${p.version}`));
    for (const id of Object.keys(pkg.allowScripts ?? {})) expect(locked.has(id), `${id} is approved but not locked`).toBe(true);
  });

  it.skipIf(!existsSync(join(root, 'node_modules')))('every installed package with an install script on this platform is approved', () => {
    const scripted: string[] = [];
    for (const name of readdirSync(join(root, 'node_modules'))) {
      const dirs = name.startsWith('@') ? readdirSync(join(root, 'node_modules', name)).map(n => `${name}/${n}`) : [name];
      for (const d of dirs) {
        const file = join(root, 'node_modules', d, 'package.json');
        if (!existsSync(file)) continue;
        const p = JSON.parse(readFileSync(file, 'utf8'));
        if (p.scripts?.install || p.scripts?.preinstall || p.scripts?.postinstall) scripted.push(`${p.name}@${p.version}`);
      }
    }
    for (const id of scripted) expect(pkg.allowScripts?.[id], id).toBe(true);
  });
});
