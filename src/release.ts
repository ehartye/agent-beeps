// What must agree before a release: every place the version is stamped, the plugin description, and the README's
// "What changed" heading for it. `beeps` has no release command; scripts/release-check.mjs and tests/release.test.ts call this.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const json = (root: string, file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));

/** One line per disagreement; empty when the repository is consistent. */
export function releaseProblems(root: string): string[] {
  const problems: string[] = [];
  const pkg = json(root, 'package.json'), lock = json(root, 'package-lock.json');
  const plugin = json(root, '.claude-plugin/plugin.json'), market = json(root, '.claude-plugin/marketplace.json');
  const entry = (market.plugins as { name: string; version: string; description: string }[]).find(p => p.name === plugin.name);
  const version: string = pkg.version;

  const stamps: [string, unknown][] = [
    ['package-lock.json version', lock.version],
    ['package-lock.json packages[""] version', lock.packages?.['']?.version],
    ['.claude-plugin/plugin.json version', plugin.version],
    ['.claude-plugin/marketplace.json plugin version', entry?.version],
  ];
  for (const [where, value] of stamps) if (value !== version) problems.push(`${where} is ${JSON.stringify(value)}, package.json says ${version}`);

  if (!entry) problems.push(`.claude-plugin/marketplace.json has no plugin named ${plugin.name}`);
  // The plugin descriptor is the source of truth: the central marketplace entry is checked against it by hand at release time.
  else if (entry.description !== plugin.description) problems.push('.claude-plugin/marketplace.json description differs from .claude-plugin/plugin.json');
  if (pkg.description !== plugin.description) problems.push('package.json description differs from .claude-plugin/plugin.json');

  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  if (!new RegExp(`^## What changed in ${version.replaceAll('.', '\.')}$`, 'm').test(readme)) problems.push(`README.md has no "## What changed in ${version}" section`);
  return problems;
}
