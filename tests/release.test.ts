import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseProblems } from '../src/release.ts';

const root = join(import.meta.dirname, '..');

describe('release consistency', () => {
  it('has one version in every place it is stamped, one description, and a README heading for it', () => {
    expect(releaseProblems(root)).toEqual([]);
  });

  it('names each disagreement', () => {
    const copy = mkdtempSync(join(tmpdir(), 'beeps-release-'));
    mkdirSync(join(copy, '.claude-plugin'));
    for (const f of ['package.json', 'package-lock.json', 'README.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) cpSync(join(root, f), join(copy, f));
    const edit = (f: string, fn: (j: any) => void) => { const p = join(copy, f); const j = JSON.parse(readFileSync(p, 'utf8')); fn(j); writeFileSync(p, JSON.stringify(j)); };
    edit('.claude-plugin/plugin.json', j => { j.version = '9.9.9'; });
    edit('.claude-plugin/marketplace.json', j => { j.plugins[0].description = 'other'; });
    edit('package-lock.json', j => { j.packages[''].version = '0.0.1'; });
    writeFileSync(join(copy, 'README.md'), '# no heading\n');
    const problems = releaseProblems(copy);
    expect(problems.join('\n')).toMatch(/plugin\.json version is "9\.9\.9"/);
    expect(problems.join('\n')).toMatch(/marketplace\.json description differs/);
    expect(problems.join('\n')).toMatch(/packages\[""\] version is "0\.0\.1"/);
    expect(problems.join('\n')).toMatch(/no "## What changed in /);
  });
});
